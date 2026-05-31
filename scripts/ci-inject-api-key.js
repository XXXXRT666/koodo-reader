const fs = require("fs");
const path = require("path");

const apiKey = process.env.API_KEY;
const pluginPath = path.join(
  __dirname,
  "..",
  "src",
  "assets",
  "plugins",
  "aliyun-custom-voice-tts-plugin.json"
);

if (!apiKey) {
  throw new Error("API_KEY is required to build the bundled Aliyun voice plugin");
}

const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
plugin.config = {
  ...plugin.config,
  apiKey,
};
fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
console.log("Injected API_KEY into bundled Aliyun custom voice plugin");
