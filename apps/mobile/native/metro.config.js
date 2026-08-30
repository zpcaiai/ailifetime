const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);
config.watchFolders = [...new Set([...(config.watchFolders || []), path.resolve(projectRoot, "..")])];
config.resolver.disableHierarchicalLookup = false;
module.exports = config;
