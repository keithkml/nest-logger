const { authGoogle, observe } = require("nest-observe");
const fs = require("fs");

const { nestRefreshToken } = require("./auth.json");

async function go() {
  // Use auth details to get JWT token. Returned object contains {token, expiry, refresh}
  // where refresh is a function to get a new token object
  const token = await authGoogle(nestRefreshToken);

  // Create the observer. Can also be done using promises
  const observer = await observe(token.token, {
    protobuf: false, // set true to return protobuf object as value
    debug: false, // set true to log a lot more
  });

  // Event emitted for new updates which include only the new values
  observer.on("data", (state) => {
    console.log("New state:", state);
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  });

  // Event emitted when the streaming is stopped
  observer.on("end", () => {
    console.log("Streaming ended");
  });
}

go().then(console.log).catch(console.error);
