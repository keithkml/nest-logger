/**
 * Code adapted from homebridge-nest
 * https://github.com/chrisjshull/homebridge-nest/blob/128392fe8f3110f2cd71e703b5b39a870b91bd96/lib/nest-connection.js
 */

"use strict";

const axios = require("axios");
const fs = require("fs");
const varint = require("varint");
const protobuf = require("protobufjs");
const http2 = require("http2");
const querystring = require("querystring");

// Workaround strange issue where sometimes int64 are mistranslated into JS objects
protobuf.util.Long = null;
protobuf.configure();

const NestEndpoints = require("./nest-endpoints.js");

// Delay after authentication fail before retrying
const API_AUTH_FAIL_RETRY_DELAY_SECONDS = 15;

// Delay after authentication fail (long) before retrying
const API_AUTH_FAIL_RETRY_LONG_DELAY_SECONDS = 60 * 60;

// Interval between Nest subscribe requests
const API_SUBSCRIBE_DELAY_SECONDS = 0.1;

// Timeout observe API calls after this number of seconds
const API_OBSERVE_TIMEOUT_SECONDS = 130;

// Timeout other API calls after this number of seconds
const API_TIMEOUT_SECONDS = 40;

// Delay after API call failure before trying again
const API_RETRY_DELAY_SECONDS = 10;

// Pre-emptive reauthentication interval for Google accounts
const API_GOOGLE_REAUTH_MINUTES = 55;

// Pre-emptive reauthentication interval for Nest accounts
const API_NEST_REAUTH_MINUTES = 20 * 24 * 60;

// HTTP/2 ping frame interval
const API_HTTP2_PING_INTERVAL_SECONDS = 60;

// URL for refresh token generation
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Client ID of the Nest iOS application
const CLIENT_ID =
  "733249279899-1gpkq9duqmdp55a7e5lft1pr2smumdla.apps.googleusercontent.com";

// Client ID of the Test Flight Beta Nest iOS application
const CLIENT_ID_FT =
  "384529615266-57v6vaptkmhm64n9hn5dcmkr4at14p8j.apps.googleusercontent.com";

class Connection {
  constructor(config, log, verbose, fieldTestMode) {
    NestEndpoints.init(fieldTestMode);

    this.config = config;
    this.token = null;
    this.connected = false;
    this.mountedDeviceCount = { rest: {}, protobuf: {} };
    this.currentState = {};
    this.proto = {};
    this.StreamBody = null;
    this.protobufUserId = null;
    this.legacyStructureMap = {};
    this.legacyDeviceMap = {};
    this.protobufBody = {};
    this.lastProtobufCode = null;
    this.associatedStreamers = [];
    this.preemptiveReauthTimer = null;
    this.cancelObserve = null;
    this.connectionFailures = 0;
    this.mergeUpdates = [];
    this.connected = false;
    this.fieldTestMode = fieldTestMode;
    this.timeoutTimer = null;

    protobuf.load(__dirname + "/protobuf/root.proto").then((root) => {
      this.proto.root = root;
      this.StreamBody = root.lookupType("nest.rpc.StreamBody");
    });

    this.log = function (...info) {
      log.info(...info);
    };

    this.debug = function (...info) {
      log.debug(...info);
    };

    this.verbose = function (...info) {
      if (verbose) {
        log.debug(...info);
      }
    };

    this.error = function (...info) {
      log.error(...info);
    };
  }

  async auth(preemptive) {
    let req, body;

    // eslint-disable-next-line
    while (true) {
      // Will return when authed successfully, or throw when cannot retry

      if (!preemptive) {
        this.connected = false;
        this.token = null;
      }
      this.debug("Authenticating via Google.");
      let result;
      let googleAccessToken;
      try {
        req = {
          method: "POST",
          timeout: API_TIMEOUT_SECONDS * 1000,
          url: TOKEN_URL,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": NestEndpoints.USER_AGENT_STRING,
          },
          data: querystring.stringify({
            refresh_token: this.config.refreshToken,
            client_id: this.fieldTestMode ? CLIENT_ID_FT : CLIENT_ID,
            grant_type: "refresh_token",
          }),
        };
        result = (await axios(req)).data;
        googleAccessToken = result.access_token;
        if (!result || result.error) {
          this.error(
            "Google authentication was unsuccessful. Make sure you did not log out of your Google account after getting your googleAuth parameters."
          );
          throw result;
        }
        req = {
          method: "POST",
          timeout: API_TIMEOUT_SECONDS * 1000,
          url: "https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt",
          data: {
            embed_google_oauth_access_token: true,
            expire_after: "3600s",
            google_oauth_access_token: googleAccessToken,
            policy_id: "authproxy-oauth-policy",
          },
          headers: {
            Authorization: "Bearer " + googleAccessToken,
            "User-Agent": NestEndpoints.USER_AGENT_STRING,
            // 'x-goog-api-key': this.config.googleAuth.apiKey,
            Referer: "https://" + NestEndpoints.NEST_API_HOSTNAME,
          },
        };
        if (this.config.googleAuth && this.config.googleAuth.apiKey) {
          req.headers["x-goog-api-key"] = this.config.googleAuth.apiKey;
        }
        result = (await axios(req)).data;
        this.config.access_token = result.jwt;
      } catch (error) {
        error.status = error.response && error.response.status;
        console.log(error);
        this.error(
          "Access token acquisition via googleAuth failed (code " +
            (error.status || error.code || error.error) +
            ")."
        );
        if (error.status == 400) {
          // Cookies expired
          return false;
        }
        if (
          (error.status && error.status >= 500) ||
          [
            "ECONNREFUSED",
            "ENOTFOUND",
            "ESOCKETTIMEDOUT",
            "ECONNABORTED",
            "ENETUNREACH",
            "EAI_AGAIN",
            "DEPTH_ZERO_SELF_SIGNED_CERT",
          ].includes(error.code)
        ) {
          this.error(
            "Retrying in " + API_AUTH_FAIL_RETRY_DELAY_SECONDS + " second(s)."
          );
          await Promise.delay(API_AUTH_FAIL_RETRY_DELAY_SECONDS * 1000);
          continue;
          // return await this.auth();
        }
      }
      if (this.config.access_token) {
        req = {
          method: "GET",
          // followAllRedirects: true,
          timeout: API_TIMEOUT_SECONDS * 1000,
          url: NestEndpoints.URL_NEST_AUTH,
          headers: {
            Authorization: "Basic " + this.config.access_token,
            "User-Agent": NestEndpoints.USER_AGENT_STRING,
            cookie:
              "G_ENABLED_IDPS=google; eu_cookie_accepted=1; viewer-volume=0.5; cztoken=" +
              this.config.access_token,
          },
        };
      }

      try {
        body = (await axios(req)).data;
        this.connected = true;
        this.token = body.access_token;
        this.transport_url = body.urls.transport_url;
        this.userid = body.userid;
        this.connectionFailures = 0;
        this.debug("Authentication successful.");
      } catch (error) {
        error.status = error.response && error.response.status;
        if (error.status == 400) {
          if (this.config.access_token) {
            this.error(
              "Auth failed: access token specified in Homebridge configuration rejected"
            );
          } else {
            this.error(
              "Auth failed: Nest rejected the account email/password specified in your Homebridge configuration file. Please check"
            );
            this.connectionFailures++;
            if (this.connectionFailures >= 6) {
              this.error(
                "Too many failed auth attempts, waiting " +
                  API_AUTH_FAIL_RETRY_LONG_DELAY_SECONDS +
                  " seconds"
              );
              await Promise.delay(
                API_AUTH_FAIL_RETRY_LONG_DELAY_SECONDS * 1000
              );
            }
            continue;
            // return await this.auth();
          }
          return false; // resolve(false);
        } else if (error.status == 429) {
          this.error(
            "Auth failed: rate limit exceeded. Please try again in 60 minutes"
          );
          return false; // resolve(false);
        } else {
          console.log(error);
          this.error(
            "Could not authenticate with Nest (code " +
              (error.status || error.code) +
              "). Retrying in " +
              API_AUTH_FAIL_RETRY_DELAY_SECONDS +
              " second(s)."
          );
          await Promise.delay(API_AUTH_FAIL_RETRY_DELAY_SECONDS * 1000);
          return await this.auth(); // .then(() => this.auth()).then(connected => resolve(connected));
        }
      }

      let isGoogle = this.config.refreshToken;
      // Google tokens expire after 60 minutes (Nest is 30 days), so refresh just before that to make sure we always have a fresh token
      if (this.preemptiveReauthTimer) {
        clearTimeout(this.preemptiveReauthTimer);
      }
      this.preemptiveReauthTimer = setTimeout(() => {
        this.debug("Initiating pre-emptive reauthentication.");
        this.auth(true).catch(() => {
          this.debug("Pre-emptive reauthentication failed.");
        });
      }, (isGoogle ? API_GOOGLE_REAUTH_MINUTES : API_NEST_REAUTH_MINUTES) * 60 * 1000);

      this.associatedStreamers.forEach((streamer) => {
        try {
          streamer.onTheFlyReauthorize();
        } catch (error) {
          this.verbose(
            "Warning: attempting to reauthorize with expired streamer",
            streamer
          );
        }
      });

      return true;
    }
  }

  mergePendingUpdates(unmergedBody) {
    let body = cloneObject(unmergedBody);

    this.mergeUpdates.forEach((update) => {
      let expiryTime = update.expiry_time;
      let obj = update.object;

      if (expiryTime > Date.now()) {
        let deviceType = obj.object_key.split(".")[0];
        let deviceId = obj.object_key.split(".")[1];
        for (const key in obj.value) {
          if (body[deviceType] && body[deviceType][deviceId]) {
            this.verbose(
              deviceType + "." + deviceId + "/" + key + ": overriding",
              body[deviceType][deviceId][key],
              "->",
              obj.value[key]
            );
            body[deviceType][deviceId][key] = obj.value[key];
          }
        }
      }
    });

    return body;
  }

  updateProtobufData(resolve, handler) {
    var notify;
    let protoBuffer = Buffer.alloc(0);
    let pendingLength = 0;

    function isEmptyObject(obj) {
      for (const prop in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, prop)) {
          return false;
        }
      }
      return true;
    }

    return new Promise((res, rej) => {
      const timeoutFunction = () => {
        this.verbose("API observe POST: session/request timed out");
        if (!client.forceClosed) {
          client.forceClosed = true;
          clearInterval(this.timeoutTimer);
          clearInterval(this.cancelObserveTimer);
          clearInterval(this.pingTimer);
          this.cancelObserve = null;
          this.timeoutTimer = null;
          this.pingTimer = null;
          res();
        }
      };

      if (!this.token || !this.connected) {
        this.verbose("API observe deferred as not connected to Nest.");
        return Promise.delay(API_RETRY_DELAY_SECONDS * 1000).then(res);
      }

      let protodata = fs.readFileSync(
        __dirname + "/protobuf/ObserveTraits.protobuf",
        null
      );

      this.verbose("API observe POST: issuing");

      this.timeoutTimer = setTimeout(
        timeoutFunction,
        API_OBSERVE_TIMEOUT_SECONDS * 1000
      );

      if (this.cancelObserve) {
        this.verbose("API observe cancelled as initiating new call.");
        try {
          this.cancelObserve();
        } catch (error) {
          // Ignore
        }
      }

      this.cancelObserve = null;
      this.cancelObserveTimer = setInterval(() => {
        if ((!this.token || !this.connected) && this.cancelObserve) {
          this.verbose("API observe cancelled as not connected to Nest.");
          try {
            this.cancelObserve();
          } catch (error) {
            // Ignore
          }
        }
      }, 1000);

      let client = http2.connect(NestEndpoints.URL_PROTOBUF, {
        maxOutstandingPings: 2,
      });
      client.on("error", (error) => {
        this.verbose("API observe POST: client error", error);
        rej(error);
      });

      client.on("stream", () => {
        this.verbose("API observe POST: new stream");
      });

      client.on("ping", (payload) => {
        this.verbose(
          "API observe POST: incoming ping",
          payload.toString("base64")
        );
      });

      /* this.observePingTimer = setInterval(() => {
                client.ping((err, duration, payload) => {
                    console.log('API observe PING:', duration, payload, err);
                    if (!client.connecting && !client.closed && err) {
                        clearInterval(this.observePingTimer);
                        client.destroy();
                    }
                });
            }, 20000); */

      client.on("close", () => {
        this.verbose("API observe POST: stream ended");
        if (!client.forceClosed) {
          client.forceClosed = true;
          clearInterval(this.timeoutTimer);
          clearInterval(this.cancelObserveTimer);
          clearInterval(this.pingTimer);
          this.cancelObserve = null;
          this.timeoutTimer = null;
          this.pingTimer = null;
          res();
        }
      });

      // API_OBSERVE_TIMEOUT_SECONDS
      /* client.setTimeout(API_OBSERVE_TIMEOUT_SECONDS * 1000, () => {
                this.verbose('API observe POST: stream timed out');
                client.destroy();
            }); */

      let req = client.request({
        ":method": "POST",
        ":path": NestEndpoints.ENDPOINT_OBSERVE,
        "User-Agent": NestEndpoints.USER_AGENT_STRING,
        "Content-Type": "application/x-protobuf",
        "X-Accept-Content-Transfer-Encoding": "binary",
        "X-Accept-Response-Streaming": "true",
        Authorization: "Basic " + this.token,
        "request-id": uuidv4(),
        referer: "https://home.nest.com/",
        origin: "https://home.nest.com",
        "x-nl-webapp-version":
          "NlAppSDKVersion/8.15.0 NlSchemaVersion/2.1.20-87-gce5742894",
      });

      this.pingTimer = setInterval(() => {
        try {
          client.ping(
            Buffer.from(uuidv4().substr(0, 8)),
            (err, duration, payload) => {
              if (!err) {
                this.verbose(
                  "API observe PING:",
                  duration,
                  "ms, payload",
                  "'" + payload.toString() + "'"
                );
                if (this.timeoutTimer) {
                  clearTimeout(this.timeoutTimer);
                  this.timeoutTimer = setTimeout(
                    timeoutFunction,
                    API_OBSERVE_TIMEOUT_SECONDS * 1000
                  );
                }
              } else {
                this.verbose(
                  "API observe PING: response error",
                  err.code || err
                );
              }
            }
          );
        } catch (error) {
          this.verbose("API observe PING: request error", error.code || error);
        }
      }, API_HTTP2_PING_INTERVAL_SECONDS * 1000);

      req.write(protodata);
      req.end();

      // this.cancelObserve = () => req.close(http2.constants.NGHTTP2_CANCEL);
      this.cancelObserve = () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        client.destroy();
      };

      /* req.on('response', (headers, flags) => {
                for (const name in headers) {
                    console.log(`${name}: ${headers[name]}`);
                }
            }); */

      req.on("data", (data) => {
        if (this.timeoutTimer) {
          clearTimeout(this.timeoutTimer);
          this.timeoutTimer = setTimeout(
            timeoutFunction,
            API_OBSERVE_TIMEOUT_SECONDS * 1000
          );
        }

        if (protoBuffer.length == 0) {
          // Start of protobuf
          pendingLength = varint.decode(data, 1);
          pendingLength += varint.decode.bytes + 1;
        }
        protoBuffer = Buffer.concat([protoBuffer, data]);
        // this.verbose('API observe POST: data received, length ' + data.length + ' (-> ' + protoBuffer.length + '/' + pendingLength + ')');
        if (protoBuffer.length >= pendingLength) {
          let protoMessage = protoBuffer.slice(0, pendingLength);
          protoBuffer = protoBuffer.slice(pendingLength);
          this.verbose(
            "API observe POST: complete message received (" +
              pendingLength +
              ")"
          );
          if (protoBuffer.length > 0) {
            pendingLength = varint.decode(protoBuffer, 1);
            pendingLength += varint.decode.bytes + 1;
          }
          let observeMessage = this.protobufToNestLegacy(protoMessage);
          if (this.lastProtobufCode) {
            try {
              client.forceClosed = true;
              clearInterval(this.timeoutTimer);
              clearInterval(this.cancelObserveTimer);
              clearInterval(this.pingTimer);
              this.cancelObserve = null;
              this.timeoutTimer = null;
              this.pingTimer = null;
              res();
              client.close();
            } catch (error) {
              // Ignore
            }
          }
          this.protobufBody = observeMessage.body;
          if (notify || observeMessage.hasDeviceInfo) {
            if (!isEmptyObject(this.protobufBody)) {
              let body = this.mergePendingUpdates(
                this.mergeNestWithProtobufData(
                  this.currentState,
                  this.protobufBody
                )
              );
              let notifyFunction = notify || resolve || handler;
              notifyFunction(this.apiResponseToObjectTree(body));
              notify = handler;
            }
          }
        }
      });
      req.on("error", (error) => {
        this.verbose("API observe POST: stream error", error);
        rej(error);
      });
    });
  }

  protobufToNestLegacy(protobuf) {
    function checkDeviceExists(body, deviceId) {
      if (
        (body.device &&
          body.device[deviceId] &&
          body.shared &&
          body.shared[deviceId]) ||
        (body.topaz && body.topaz[deviceId]) ||
        (body.kryptonite && body.kryptonite[deviceId]) ||
        (body.yale && body.yale[deviceId]) ||
        (body.guard && body.guard[deviceId]) ||
        (body.detect && body.detect[deviceId])
      ) {
        return true;
      } else {
        // this.verbose('Warning: trying to set property for unmounted device ' + deviceId);
        return false;
      }
    }

    function toLegacy(id) {
      return id.split("_")[1];
    }

    const translateProperty = (object, propName, constructor, enumerator) => {
      let propObjects = getProtoObject(object, propName);
      if (propObjects) {
        // console.log('(Found', propObjects.length, 'objects matching', propName + ')');
        if (constructor) {
          constructor();
        }
        propObjects.forEach((propObject) => {
          try {
            enumerator(propObject, toLegacy(propObject.object.id));
          } catch (error) {
            console.log(
              "Warning: error enumerating property",
              propName + "@" + propObject.object.id
            );
          }
        });
      }
    };

    const initDevice = (
      deviceType,
      deviceId,
      structureId,
      fwVersion,
      body,
      protobufDeviceType
    ) => {
      this.legacyDeviceMap[deviceId] = deviceType;
      if (!body[deviceType]) {
        body[deviceType] = {};
      }

      body[deviceType][deviceId] = {};

      body[deviceType][deviceId].using_protobuf = true;
      body[deviceType][deviceId].device_id = deviceId;
      body[deviceType][deviceId].structure_id = structureId;
      body[deviceType][deviceId].current_version = fwVersion;
      body[deviceType][deviceId].user_id = this.protobufUserId;
      if (protobufDeviceType) {
        body[deviceType][deviceId].protobuf_device_type = protobufDeviceType;
      }

      if (!body.structure[structureId].swarm) {
        body.structure[structureId].swarm = [];
      }
      body.structure[structureId].swarm.push(deviceType + "." + deviceId);
    };

    let body = this.protobufBody,
      message,
      object;
    let hasDeviceInfo = false;

    try {
      message = this.StreamBody.decode(protobuf);
      object = this.StreamBody.toObject(message, {
        enums: String,
        defaults: true,
      });
    } catch (error) {
      // Not a Nest device info object
      return { body: body, hasDeviceInfo: false };
    }
    try {
      if (object.status) {
        this.verbose("object.status", object.status);
        this.lastProtobufCode = object.status;
      } else {
        this.lastProtobufCode = null;
      }
      if (object && object.message && object.message.length > 0) {
        this.verbose("Protobuf message object length", object.message.length);
        object = object.message[0].get;
        if (object) {
          transformTraits(object, this.proto);

          let keyList = getProtoKeys(object);
          this.verbose(
            "Protobuf updated properties:",
            keyList
              .map((el) => el[0] + "@" + el[1] + " (" + el[2] + ")")
              .join(", ")
          );

          translateProperty(object, "user_info", null, (userInfo) => {
            this.verbose(
              "Legacy user mapping",
              userInfo.object.id,
              "->",
              userInfo.data.property.value.legacyId
            );
            this.protobufUserId = userInfo.object.id;
            hasDeviceInfo = true;
          });

          translateProperty(
            object,
            "structure_info",
            () => {
              if (!body.structure) {
                body.structure = {};
              }
            },
            (el, id) => {
              let structureId = el.data.property.value.legacyId.split(".")[1];
              body.structure[structureId] = {
                structure_id: structureId,
                new_structure_id: id,
                user_id: this.protobufUserId,
                using_protobuf: true,
              };
              this.legacyStructureMap[id] = structureId;
            }
          );

          translateProperty(
            object,
            "located_annotations",
            () => {
              if (!body.where) {
                body.where = {};
              }
            },
            (el, id) => {
              let structureId = this.legacyStructureMap[id];
              if (structureId) {
                body.where[structureId] = { wheres: [] };
                (el.data.property.value.annotations || []).forEach((el) => {
                  body.where[structureId].wheres.push({
                    where_id: el.info.id.value,
                    name: el.info.name.value,
                  });
                });
                (el.data.property.value.customAnnotations || []).forEach(
                  (el) => {
                    body.where[structureId].wheres.push({
                      where_id: el.info.id.value,
                      name: el.info.name.value,
                    });
                  }
                );
              }
            }
          );

          translateProperty(object, "liveness", null, (liveness, id) => {
            this.verbose(
              "Liveness",
              id,
              "->",
              liveness.data.property.value.status
            );
            // if (checkDeviceExists(body, id)) {
            if (!body.track) {
              body.track = {};
            }
            body.track[id] = {
              online:
                liveness.data.property.value.status ==
                "LIVENESS_DEVICE_STATUS_ONLINE",
            };
            // }
          });

          translateProperty(object, "peer_devices", null, (peerDevice, id) => {
            // console.log('peer_devices', id);
            let structureId = this.legacyStructureMap[id];
            if (!peerDevice.object.id.startsWith("STRUCTURE_")) {
              // Continue
            } else if (!structureId) {
              this.debug("Cannot determine legacy structure ID for new ID", id);
            } else {
              // console.log(peerDevice);
              let oldMountedDeviceCount = cloneObject(this.mountedDeviceCount);
              this.mountedDeviceCount.protobuf[structureId] =
                peerDevice.data.property.value.devices.length;
              this.verbose(
                "Protobuf API: structure " + structureId + ", found",
                this.mountedDeviceCount.protobuf[structureId],
                "device(s)"
              );
              if (
                oldMountedDeviceCount.protobuf[structureId] !== undefined &&
                oldMountedDeviceCount.protobuf[structureId] !==
                  this.mountedDeviceCount.protobuf[structureId]
              ) {
                this.verbose(
                  "Protobuf API: found device count for structure",
                  structureId,
                  "has changed (protobuf):",
                  oldMountedDeviceCount.protobuf[structureId],
                  "->",
                  this.mountedDeviceCount.protobuf[structureId]
                );
                if (this.config.exitOnDeviceListChanged) {
                  process.exit(1);
                }
              }
              peerDevice.data.property.value.devices.forEach((el) => {
                // console.log('device', el);

                let deviceId = toLegacy(el.data.deviceId.value);
                let deviceType = el.data.deviceType.value;
                this.verbose(
                  "Found device " + el.data.deviceId.value + "@" + deviceType
                );

                if (
                  body.track &&
                  body.track[deviceId] &&
                  !body.track[deviceId].online
                ) {
                  this.verbose("----> ignoring as unreachable");
                } else if (
                  [
                    "nest.resource.NestLearningThermostat3Resource",
                    "nest.resource.NestAgateDisplayResource",
                    "nest.resource.NestOnyxResource",
                    "google.resource.GoogleZirconium1Resource",
                  ].includes(deviceType)
                ) {
                  // Nest Learning Thermostat 3rd Generation, Thermostat E with Heat Link, 1st Gen US Thermostat E, new Google Nest Thermostat
                  this.verbose("----> mounting as Nest Thermostat");
                  initDevice(
                    "device",
                    deviceId,
                    structureId,
                    el.data.fwVersion,
                    body,
                    deviceType
                  );

                  if (!body.shared) {
                    body.shared = {};
                  }
                  body.shared[deviceId] = {};
                } else if (
                  deviceType == "nest.resource.NestKryptoniteResource"
                ) {
                  // Nest Temperature Sensor
                  this.verbose("----> mounting as Nest Temperature Sensor");
                  initDevice(
                    "kryptonite",
                    deviceId,
                    structureId,
                    el.data.fwVersion,
                    body,
                    deviceType
                  );
                } else if (deviceType == "yale.resource.LinusLockResource") {
                  // Nest x Yale Lock
                  this.verbose("----> mounting as Nest x Yale Lock");
                  initDevice(
                    "yale",
                    deviceId,
                    structureId,
                    el.data.fwVersion,
                    body,
                    deviceType
                  );
                } else {
                  this.verbose("----> ignoring as currently unsupported type");
                }
              });
            }
          });

          translateProperty(
            object,
            "device_located_settings",
            null,
            (deviceLocatedSetting, id) => {
              // console.log('device_located_settings', id);
              if (
                checkDeviceExists(body, id) &&
                deviceLocatedSetting.data.property.value.whereId
              ) {
                let deviceKey = this.legacyDeviceMap[id];
                body[deviceKey][id].where_id =
                  deviceLocatedSetting.data.property.value.whereId.value;
                body[deviceKey][id].fixture_type =
                  deviceLocatedSetting.data.property.value.fixtureType &&
                  deviceLocatedSetting.data.property.value.fixtureType
                    .majorType;
              }
            }
          );

          translateProperty(
            object,
            "device_identity",
            null,
            (deviceIdentity, id) => {
              // console.log('device_identity', id, deviceIdentity.data.property.value);
              if (checkDeviceExists(body, id)) {
                let deviceKey = this.legacyDeviceMap[id];
                body[deviceKey][id][
                  deviceKey == "topaz" ? "model" : "model_name"
                ] =
                  deviceIdentity.data.property.value.modelName &&
                  deviceIdentity.data.property.value.modelName.value;
                body[deviceKey][id].serial_number =
                  deviceIdentity.data.property.value.serialNumber;
                body[deviceKey][id].current_version =
                  deviceIdentity.data.property.value.fwVersion;
              }
            }
          );

          translateProperty(
            object,
            "hvac_equipment_capabilities",
            null,
            (hvacEquipmentCapability, id) => {
              // console.log('hvac_equipment_capabilities', id);
              if (checkDeviceExists(body, id)) {
                body.device[id].can_heat =
                  !!hvacEquipmentCapability.data.property.value.canHeat;
                body.device[id].can_cool =
                  !!hvacEquipmentCapability.data.property.value.canCool;
              }
            }
          );

          translateProperty(object, "hvac_control", null, (hvacControl, id) => {
            // console.log('hvac_control', id, JSON.stringify(hvacControl, null, 2));
            if (checkDeviceExists(body, id)) {
              body.device[id].hvac_heater_state =
                !!hvacControl.data.property.value.settings.isHeating;
              body.device[id].hvac_ac_state =
                !!hvacControl.data.property.value.settings.isCooling;
            }
          });

          translateProperty(
            object,
            "target_temperature_settings",
            null,
            (targetTemperatureSetting, id) => {
              if (checkDeviceExists(body, id)) {
                let hvac_mode = !targetTemperatureSetting.data.property.value
                  .active.value
                  ? "off"
                  : targetTemperatureSetting.data.property.value.settings.hvacMode.toLowerCase();
                body.shared[id].target_temperature_type = hvac_mode;
                body.shared[id].target_temperature_low =
                  targetTemperatureSetting.data.property.value.settings.targetTemperatureHeat.value;
                body.shared[id].target_temperature_high =
                  targetTemperatureSetting.data.property.value.settings.targetTemperatureCool.value;
                if (hvac_mode == "heat") {
                  body.shared[id].target_temperature =
                    body.shared[id].target_temperature_low;
                } else if (hvac_mode == "cool") {
                  body.shared[id].target_temperature =
                    body.shared[id].target_temperature_high;
                } else {
                  body.shared[id].target_temperature =
                    0.5 *
                    (body.shared[id].target_temperature_high +
                      body.shared[id].target_temperature_low);
                }
              }
            }
          );

          translateProperty(object, "fan_control", null, (fanControl, id) => {
            // console.log('fan_control', id, JSON.stringify(fanControl, null, 2));
            if (checkDeviceExists(body, id)) {
              body.device[id].hvac_fan_state = [
                "FAN_SPEED_SETTING_STAGE1",
                "FAN_SPEED_SETTING_STAGE2",
                "FAN_SPEED_SETTING_STAGE3",
              ].includes(fanControl.data.property.value.currentSpeed);
            }
          });

          translateProperty(
            object,
            "fan_control_settings",
            null,
            (fanControlSetting, id) => {
              if (checkDeviceExists(body, id)) {
                body.device[id].has_fan = true;
                body.device[id].fan_timer_active =
                  fanControlSetting.data.property.value.fanTimerTimeout &&
                  !!fanControlSetting.data.property.value.fanTimerTimeout.value;
                body.device[id].fan_timer_timeout = body.device[id]
                  .fan_timer_active
                  ? fanControlSetting.data.property.value.fanTimerTimeout.value
                  : 0;
                body.device[id].fan_timer_duration = Math.max(
                  body.device[id].fan_timer_active
                    ? fanControlSetting.data.property.value.fanTimerTimeout
                        .value -
                        Date.now() / 1000
                    : 0,
                  0
                );

                // Protobuf-only fan properties
                body.device[id].fan_mode_protobuf =
                  fanControlSetting.data.property.value.mode;
                body.device[id].fan_hvac_override_speed_protobuf =
                  fanControlSetting.data.property.value.hvacOverrideSpeed;
                body.device[id].fan_schedule_speed_protobuf =
                  fanControlSetting.data.property.value.scheduleSpeed;
                body.device[id].fan_schedule_duty_cycle_protobuf =
                  fanControlSetting.data.property.value.scheduleDutyCycle;
                body.device[id].fan_schedule_start_time_protobuf =
                  fanControlSetting.data.property.value.scheduleStartTime;
                body.device[id].fan_schedule_end_time_protobuf =
                  fanControlSetting.data.property.value.scheduleEndTime;
                body.device[id].fan_timer_speed_protobuf =
                  fanControlSetting.data.property.value.timerSpeed;
              }
            }
          );

          translateProperty(
            object,
            "eco_mode_state",
            null,
            (ecoModeState, id) => {
              if (checkDeviceExists(body, id)) {
                body.device[id].eco = {
                  mode:
                    ecoModeState.data.property.value.ecoEnabled == "OFF"
                      ? "schedule"
                      : "manual-eco",
                };
              }
            }
          );

          translateProperty(
            object,
            "eco_mode_settings",
            null,
            (ecoModeSetting, id) => {
              if (checkDeviceExists(body, id)) {
                body.device[id].auto_away_enable =
                  !!ecoModeSetting.data.property.value.autoEcoEnabled;
                body.device[id].away_temperature_low =
                  ecoModeSetting.data.property.value.low.temperature.value;
                body.device[id].away_temperature_low_enabled =
                  !!ecoModeSetting.data.property.value.low.enabled;
                body.device[id].away_temperature_high =
                  ecoModeSetting.data.property.value.high.temperature.value;
                body.device[id].away_temperature_high_enabled =
                  !!ecoModeSetting.data.property.value.high.enabled;
              }
            }
          );

          translateProperty(
            object,
            "display_settings",
            null,
            (displaySetting, id) => {
              if (checkDeviceExists(body, id)) {
                body.device[id].temperature_scale =
                  displaySetting.data.property.value.units == "DEGREES_F"
                    ? "F"
                    : "C";
              }
            }
          );

          translateProperty(
            object,
            "remote_comfort_sensing_settings",
            null,
            (rcsSetting, id) => {
              // console.log(JSON.stringify(rcsSetting, null, 2));
              if (checkDeviceExists(body, id)) {
                let rcsSensors = [];
                try {
                  rcsSensors =
                    rcsSetting.data.property.value.associatedRcsSensors
                      .map((el) => el.deviceId && el.deviceId.resourceId)
                      .map((el) => "kryptonite." + el.split("_")[1]);
                } catch (error) {
                  // Ignore if can't get RCS sensors
                }
                if (!body.rcs_settings) {
                  body.rcs_settings = {};
                }
                // console.log('rcsSensors', rcsSensors);
                body.rcs_settings[id] = { associated_rcs_sensors: rcsSensors };
              }
            }
          );

          translateProperty(
            object,
            "backplate_temperature",
            null,
            (backplateTemperature, id) => {
              if (checkDeviceExists(body, id)) {
                body.device[id].backplate_temperature =
                  backplateTemperature.data.property.value.temperature.value.value;
              }
            }
          );

          translateProperty(
            object,
            "current_temperature",
            null,
            (currentTemperature, id) => {
              let deviceKey = this.legacyDeviceMap[id];
              if (checkDeviceExists(body, id)) {
                body[deviceKey][id].current_temperature =
                  currentTemperature.data.property.value.temperature.value.value;
              }
            }
          );

          translateProperty(
            object,
            "current_humidity",
            null,
            (currentHumidity, id) => {
              if (checkDeviceExists(body, id)) {
                body.device[id].current_humidity =
                  currentHumidity.data.property.value.humidity.value.value;
              }
            }
          );

          translateProperty(object, "bolt_lock", null, (boltLock, id) => {
            if (checkDeviceExists(body, id)) {
              body.yale[id].bolt_locked =
                boltLock.data.property.value.lockedState ==
                "BOLT_LOCKED_STATE_LOCKED";
              body.yale[id].bolt_moving =
                boltLock.data.property.value.actuatorState !=
                "BOLT_ACTUATOR_STATE_OK";
              body.yale[id].bolt_moving_to =
                boltLock.data.property.value.actuatorState ==
                "BOLT_ACTUATOR_STATE_LOCKING";
              this.verbose(
                "Protobuf lock state updated:",
                boltLock.data.property.value.actuatorState,
                boltLock.data.property.value.lockedState
              );
            }
          });

          translateProperty(
            object,
            "structure_mode",
            null,
            (structureMode, id) => {
              let legacyId = this.legacyStructureMap[id];
              // console.log(legacyId, JSON.stringify(structureMode, null, 2));
              if (body.structure[legacyId]) {
                body.structure[legacyId].protobuf_away = [
                  "STRUCTURE_MODE_AWAY",
                  "STRUCTURE_MODE_SLEEP",
                  "STRUCTURE_MODE_VACATION",
                ].includes(structureMode.data.property.value.structureMode);
              }
            }
          );

          // Nest x Yale lock: battery status property is called battery_power_source
          translateProperty(
            object,
            "battery_power_source",
            null,
            (batteryStatus, id) => {
              let deviceKey = this.legacyDeviceMap[id];
              if (checkDeviceExists(body, id)) {
                body[deviceKey][id].battery_status =
                  batteryStatus.data.property.value.replacementIndicator;
                body[deviceKey][id].battery_voltage =
                  batteryStatus.data.property.value.assessedVoltage &&
                  batteryStatus.data.property.value.assessedVoltage.value;
              }
            }
          );

          // All other devices: battery status property is called battery
          translateProperty(object, "battery", null, (batteryStatus, id) => {
            let deviceKey = this.legacyDeviceMap[id];
            if (checkDeviceExists(body, id)) {
              body[deviceKey][id].battery_status =
                batteryStatus.data.property.value.replacementIndicator;
              body[deviceKey][id].battery_voltage =
                batteryStatus.data.property.value.assessedVoltage &&
                batteryStatus.data.property.value.assessedVoltage.value;
            }
          });
        }
      }
    } catch (error) {
      this.verbose("Protobuf decode error:", error);
    }

    /* if (hasDeviceInfo) {
            console.log('***', JSON.stringify(body, null, 2));
        } */
    return { body: body, hasDeviceInfo: hasDeviceInfo };
  }

  apiResponseToObjectTree(body) {
    let data = {};
    data.devices = {};
    data.devices["thermostats"] = {};
    data.devices["home_away_sensors"] = {};
    data.devices["temp_sensors"] = {};
    data.devices["smoke_co_alarms"] = {};
    data.devices["cameras"] = {};
    data.devices["locks"] = {};
    data.devices["guards"] = {};
    data.devices["detects"] = {};

    let structures = body.structure || {};
    let shared = body.shared || {};
    let topaz = body.topaz || {};
    let device = body.device || {};
    let rcs_settings = body.rcs_settings || {};
    let kryptonite = body.kryptonite || {};
    let track = body.track || {};
    let yale = body.yale || {};

    for (const structureId in structures) {
      let thisStructure = structures[structureId];

      let whereLookup = {};
      if (body.where[structureId]) {
        let wheres = body.where[structureId].wheres || {};
        wheres.forEach((where) => (whereLookup[where.where_id] = where.name));
      }

      thisStructure.structure_id = structureId;

      // Set up home/away sensor
      data.devices["home_away_sensors"][structureId] = {};
      data.devices["home_away_sensors"][structureId].structure_id = structureId;
      data.devices["home_away_sensors"][structureId].device_id = structureId;
      data.devices["home_away_sensors"][structureId].software_version = null;
      data.devices["home_away_sensors"][structureId].serial_number =
        structureId;
      if (Object.keys(structures).length > 1) {
        data.devices["home_away_sensors"][structureId].name =
          "Home Occupied - " + thisStructure.name;
      } else {
        data.devices["home_away_sensors"][structureId].name = "Home Occupied";
      }
      data.devices["home_away_sensors"][structureId].model =
        "Home/Away Control";
      data.devices["home_away_sensors"][structureId].away =
        thisStructure.new_structure_id
          ? thisStructure.protobuf_away
          : thisStructure.away;

      let swarm = thisStructure.swarm;
      swarm
        .map((unit) => unit.split("."))
        .forEach((unit) => {
          try {
            let deviceType = unit[0];
            let deviceId = unit[1];

            if (deviceType == "device") {
              // Detected thermostat

              let thisDevice = device[deviceId];

              for (const sKey in shared[deviceId]) {
                thisDevice[sKey] = shared[deviceId][sKey];
              }

              thisDevice.uses_heat_link = !!thisDevice.heat_link_connection;
              if (thisDevice.uses_heat_link) {
                // EU/UK Heat Link thermostats use some slightly different fields, and support heat mode only
                if (thisDevice.target_temperature_type === undefined) {
                  thisDevice.target_temperature_type =
                    thisDevice.maint_band_lower == 0 ? "OFF" : "HEAT";
                }
                if (thisDevice.hvac_heater_state === undefined) {
                  thisDevice.hvac_heater_state = !thisDevice.leaf;
                }
                thisDevice.can_heat = true;
                thisDevice.can_cool = false;
              }
              thisDevice.device_id = deviceId;
              thisDevice.structure_id = structureId;
              thisDevice.where_name = whereLookup[thisDevice.where_id];
              thisDevice.name =
                (thisDevice.name || thisDevice.where_name || "Nest") +
                " Thermostat";
              thisDevice.fan_timer_active =
                thisDevice.fan_timer_timeout > 0 || thisDevice.hvac_fan_state;
              thisDevice.previous_hvac_mode =
                thisDevice.target_temperature_type.toLowerCase();
              thisDevice.has_eco_mode = !!thisDevice.eco;
              if (
                thisDevice.has_eco_mode &&
                thisDevice.protobuf_device_type !=
                  "google.resource.GoogleZirconium1Resource"
              ) {
                thisDevice.hvac_mode =
                  thisDevice.eco.mode == "manual-eco" ||
                  thisDevice.eco.mode == "auto-eco"
                    ? "eco"
                    : thisDevice.previous_hvac_mode;
              } else {
                thisDevice.hvac_mode = thisDevice.previous_hvac_mode;
              }
              thisDevice.software_version = thisDevice.current_version;
              thisDevice.hvac_state =
                thisDevice.can_heat && thisDevice.hvac_heater_state
                  ? "heating"
                  : thisDevice.can_cool && thisDevice.hvac_ac_state
                  ? "cooling"
                  : "off";
              thisDevice.is_online = track[deviceId] && track[deviceId].online;

              // Add data for any Nest Temperature Sensors
              if (
                rcs_settings[deviceId] &&
                rcs_settings[deviceId].associated_rcs_sensors
              ) {
                rcs_settings[deviceId].associated_rcs_sensors.forEach(
                  (sensorName) => {
                    let sensorId = sensorName.split(".")[1];
                    let thisSensor = kryptonite[sensorId];
                    if (thisSensor) {
                      data.devices["temp_sensors"][sensorId] = {
                        thermostat_device_id: deviceId,
                        structure_id: structureId,
                        device_id: sensorId,
                        serial_number: thisSensor.serial_number,
                        name:
                          whereLookup[thisSensor.where_id] ||
                          "Nest Temperature Sensor",
                        current_temperature: thisSensor.current_temperature,
                        temperature_scale: thisDevice.temperature_scale,
                        battery_voltage: thisSensor.battery_level
                          ? thisSensor.battery_level > 66
                            ? 3
                            : 2.5
                          : 0,
                        using_protobuf: thisSensor.using_protobuf,
                        protobuf_device_type: thisSensor.protobuf_device_type,
                      };
                      thisDevice.has_temperature_sensors = true;
                    }
                  }
                );
              }
              data.devices["thermostats"][deviceId] = thisDevice;
            } else if (deviceType == "topaz") {
              // Detected Nest Protect

              let thisDevice = topaz[deviceId];
              thisDevice.device_id = deviceId;
              thisDevice.where_name = whereLookup[thisDevice.where_id];
              thisDevice.name =
                thisDevice.description ||
                thisDevice.where_name ||
                "Nest Protect";
              thisDevice.smoke_alarm_state =
                thisDevice.smoke_status == 0 ? "ok" : "emergency";
              thisDevice.co_alarm_state =
                thisDevice.co_status == 0 ? "ok" : "emergency";
              thisDevice.battery_health =
                thisDevice.battery_health_state == 0 ? "ok" : "low";
              thisDevice.is_online = thisDevice.component_wifi_test_passed;
              data.devices["smoke_co_alarms"][deviceId] = thisDevice;
            } else if (deviceType == "yale") {
              // Detected Nest x Yale Lock

              let thisDevice = yale[deviceId];
              thisDevice.device_id = deviceId;
              thisDevice.software_version = thisDevice.current_version;
              thisDevice.where_name = whereLookup[thisDevice.where_id];
              thisDevice.name =
                (thisDevice.description ||
                  thisDevice.where_name ||
                  "Nest x Yale") + " Lock";
              data.devices["locks"][deviceId] = yale[deviceId];
            }
          } catch (error) {
            // We found a customer with a 'ghost' thermostat that was presumably half-installed at
            // some point, and then removed. This thermostat was missing all its properties, so we
            // need to catch error conditions in general and not prevent other devices from mounting
            this.log(
              "Warning: unable to use REST API device " +
                unit[1] +
                " (" +
                unit[0] +
                ") due to missing required properties."
            );
          }
        });
    }

    data.structures = structures;
    return data;
  }

  protobufDataTimerLoop(resolve, handler) {
    var apiLoopTimer;

    this.verbose("API observe POST: streaming request initiated");
    this.updateProtobufData(resolve, handler)
      .then(() => {
        this.verbose("API observe POST: streaming request concluded");
        // Token has probably expired, or transport endpoint has changed - re-authenticate
        // console.log(this.lastProtobufCode);
        // code 4: context timed out
        // code 7: invalid authentication
        // code 8: message quota exceeded
        // code 13: internal error encountered
        // code 14: socket closed / OS error
        if (this.lastProtobufCode && this.lastProtobufCode.code == 13) {
          this.error(
            "API observe: internal error, waiting for " +
              API_RETRY_DELAY_SECONDS +
              " seconds, code",
            this.lastProtobufCode
          );
          return Promise.delay(API_RETRY_DELAY_SECONDS * 1000);
        } else if (this.lastProtobufCode && this.lastProtobufCode.code == 7) {
          // Was != 4
          this.log("Reauthenticating on Nest service ...");
          return this.auth().catch(() => {
            this.log(
              "Reauthentication failed, waiting for " +
                API_AUTH_FAIL_RETRY_DELAY_SECONDS +
                " seconds."
            );
            return Promise.delay(API_AUTH_FAIL_RETRY_DELAY_SECONDS * 1000);
          });
        } else {
          this.verbose(
            "API observe: resolving null, code",
            this.lastProtobufCode
          );
          this.lastProtobufCode = null;
          return Promise.resolve(null);
        }
      })
      .catch((error) => {
        this.error("API observe: error", error);
        this.error("Retrying in " + API_RETRY_DELAY_SECONDS + " seconds.");
        return Promise.delay(API_RETRY_DELAY_SECONDS * 1000);
      })
      .finally(() => {
        this.verbose("API observe: setting issue timer.");
        apiLoopTimer = setInterval(() => {
          if (apiLoopTimer) {
            clearInterval(apiLoopTimer);
          }
          this.protobufDataTimerLoop(null, handler);
        }, API_SUBSCRIBE_DELAY_SECONDS * 1000);
      });
  }

  observe(handler) {
    return new Promise((resolve) => {
      this.protobufDataTimerLoop(resolve, handler);
    });
  }

  mergeNestWithProtobufData(nestApiData, data) {
    // console.log('*** merging', JSON.stringify(nestApiData, null, 2), 'with', JSON.stringify(data, null, 2));

    for (const el in data) {
      if (typeof data[el] == "object" && data[el] && !Array.isArray(data[el])) {
        if (!nestApiData[el]) {
          nestApiData[el] = cloneObject(data[el]);
        } else {
          nestApiData[el] = this.mergeNestWithProtobufData(
            nestApiData[el],
            data[el]
          );
        }
      } else if (Array.isArray(data[el])) {
        data[el].forEach((val) => {
          if (!nestApiData[el]) {
            nestApiData[el] = {};
          }
          if (!nestApiData[el].includes(val)) {
            nestApiData[el].push(val);
          }
        });
      } else if (typeof data[el] == "object") {
        nestApiData[el] = cloneObject(data[el]);
      } else {
        nestApiData[el] = data[el];
      }
    }

    return nestApiData;
  }
}

function cloneObject(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function transformTraits(object, proto) {
  object.forEach((el) => {
    let type_url = el.data.property.type_url;
    let buffer = el.data.property.value;

    let pbufTrait = lookupTrait(proto, type_url);
    if (pbufTrait && buffer) {
      // console.log('Decoding buffer for trait: ' + type_url, buffer.toString('base64'));
      el.data.property.value = pbufTrait.toObject(pbufTrait.decode(buffer), {
        enums: String,
        defaults: true,
      });
    }
  });
}

function lookupTrait(proto, type_url) {
  let pbufTrait = null;
  for (const traitKey in proto) {
    try {
      pbufTrait =
        pbufTrait || proto[traitKey].lookupType(type_url.split("/")[1]);
    } catch (error) {
      // Do nothing
    }
  }

  return pbufTrait;
}

function getProtoObject(object, key) {
  return object.filter((el) => el.object.key == key);
}

function getProtoKeys(object) {
  return object.map((el) => [
    el.object.key,
    el.object.id,
    el.data && el.data.property && el.data.property.type_url,
  ]);
}

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

module.exports = Connection;
