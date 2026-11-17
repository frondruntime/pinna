// The plugins a MobX app with legacy decorators uses, so they build the same way.
// One addition, for code outside this app: pinna-core declares fields with
// `declare`; the class-properties plugin runs before the preset strips types,
// so types are stripped first here, with JSX parsed only in .tsx files.
// JavaScript is left to the preset: React Native's Flow sources declare
// fields that are read-only on the prototype, and the class-properties plugin
// would assign them in the constructor before Flow strips the declarations.
const plugins = (isTSX) => [
  ["@babel/plugin-transform-typescript", { allowDeclareFields: true, isTSX }],
  ["@babel/plugin-proposal-decorators", { version: "legacy" }],
  ["@babel/plugin-transform-class-properties", { loose: true }],
  ["@babel/plugin-transform-private-methods", { loose: true }],
  ["@babel/plugin-transform-private-property-in-object", { loose: true }],
];

module.exports = function configureBabel(api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    overrides: [
      { test: /\.tsx$/, plugins: plugins(true) },
      { test: /\.(ts|mts|cts)$/, plugins: plugins(false) },
    ],
  };
};
