module.exports = function configure(api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"], plugins: ["@expo/ui/babel-plugin"] };
};
