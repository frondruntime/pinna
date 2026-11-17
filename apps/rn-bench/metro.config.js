// Metro sees the workspace, so Pinna's packages resolve, and every
// import of react or react-native resolves to this app's copy.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const app = __dirname;
const workspace = path.resolve(app, "../..");
const config = getDefaultConfig(app);

config.watchFolders = [workspace];
config.resolver.nodeModulesPaths = [
  path.join(app, "node_modules"),
  path.join(workspace, "node_modules"),
];
// Pinna's packages from their source, so the app needs no build of them.
config.resolver.unstable_conditionNames = ["source", ...config.resolver.unstable_conditionNames];
const single = new Set(["react", "react-native"]);
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const root = moduleName.split("/")[0];
  const fromApp = single.has(root)
    ? { ...context, originModulePath: path.join(app, "index.ts") }
    : context;
  return (resolveRequest ?? context.resolveRequest)(fromApp, moduleName, platform);
};

module.exports = config;
