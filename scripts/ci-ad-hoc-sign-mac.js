const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function adHocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    { stdio: "inherit" }
  );
};
