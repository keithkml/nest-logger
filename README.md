# Nest Logger

Logs structured information about your home's Nest thermostats to third-party logging services like Datadog. You can use this to:

- Learn about your home's heating and cooling performance & patterns
- Experiment with energy efficiency techniques

You could also fork & extend it to control your heating & cooling appliances via the Nest API.

<img width="1257" alt="Screen Shot 2021-11-21 at 3 02 07 PM" src="https://user-images.githubusercontent.com/7430512/142777093-838210d9-41c6-4230-ad67-73aba1435505.png">

## Getting Started
1. Create a file called `auth.json` (see below)
2. Run `node nest-logger.js`

That's it! You should see your home data in your logging service within a few minutes.

### `auth.json` format

Sample:
```json
{
    "nestRefreshToken": "1//jkasdfjasdfjasdf-adsfaskdfaksdf-5d-AB--jXjLuU0S8XjDjf",
    "datadogApiKey": " 4f089ce1054244157e53d92760cec66"
}
```

#### Datadog API key
Your Datadog API key can be generated via the website ([docs](https://docs.datadoghq.com/account_management/api-app-keys/))

#### Google Nest Refresh Token
_(instructions & code copied from [homebridge-nest README](https://github.com/chrisjshull/homebridge-nest/blob/128392fe8f3110f2cd71e703b5b39a870b91bd96/README.md))_

The `"refreshToken"` is a code provided by Google when you log into your account, and we provide an easy-to-use tool to obtain it.

Just run: `node nest-login.js` and follow the instructions on the screen. 

You'll be prompted to navigate to a URL in your browser, log into Google, and copy and paste a code from your browser into the login tool. You'll then be provided with the `"refreshToken"` to add to `config.json`. The refresh token is a random string
of letters and numbers - it does not begin with, end with, or contain any spaces. Please make sure you copy and paste it exactly as shown, or it will not work.

### Troubleshooting

When you run it, you should see something like this:

```json
{"instance":0.9169385740067195,"level":"info","message":"starting up","service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":"authed: true","service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","service":"nest-logger"}
```
Then it might take a few seconds or a few minutes (I don't know why) before you see this:
```json
{"instance":0.9169385740067195,"level":"info","message":"got data","service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"cooling":false,"fan":false,"fanMode":"FAN_MODE_AUTO","heating":false,"humidity":35.899993896484375,"mode":"heat","msgType":"thermostat","room":"Living Room","sensor":"Living Room Thermostat","state":"off","targetTemp":73.01753845214844,"targetTempType":"heat","temp":73.4},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"cooling":false,"fan":false,"fanMode":"FAN_MODE_AUTO","heating":false,"humidity":42.399993896484375,"mode":"heat","msgType":"thermostat","room":"Entryway","sensor":"Entryway Thermostat","state":"off","targetTemp":72.79863586425782,"targetTempType":"heat","temp":72.30199890136718},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"cooling":false,"fan":false,"fanMode":"FAN_MODE_AUTO","heating":false,"humidity":44.09999084472656,"mode":"range","msgType":"thermostat","room":"Master Bedroom","sensor":"Master Bedroom Thermostat","state":"off","targetTemp":70.60386962890625,"targetTempType":"range","temp":69.60199890136718},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"msgType":"sensor","sensor":"Kitchen","temp":73.57998352050781},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"msgType":"sensor","sensor":"Living Room","temp":73.4},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"msgType":"sensor","sensor":"Play Room","temp":72.31998901367187},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"msgType":"sensor","sensor":"Sam’s Office","temp":75.3799835205078},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"msgType":"sensor","sensor":"Master Bedroom","temp":69.61998901367187},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"msgType":"sensor","sensor":"Kids Room","temp":67.63997802734374},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"msgType":"sensor","sensor":"Keith’s Office","temp":69.61998901367187},"service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"away":false,"msgType":"homeAway"},"service":"nest-logger"}
```
The application polls forever, so every few minutes you will see more output:
```json
{"instance":0.9169385740067195,"level":"info","message":"got data","service":"nest-logger"}
{"instance":0.9169385740067195,"level":"info","message":{"cooling":false,"fan":false,"fanMode":"FAN_MODE_AUTO","heating":false,"humidity":35.899993896484375,"mode":"heat","msgType":"thermostat","room":"Living Room","sensor":"Living Room Thermostat","state":"off","targetTemp":73.01753845214844,"targetTempType":"heat","temp":73.4},"service":"nest-logger"}
```
