const { pathsToModuleNameMapper } = require("ts-jest");

const { compilerOptions } = require("../shared/tsconfig.libs");

module.exports = {
  displayName: "libs/angular tests",
  preset: "jest-preset-angular",
  testMatch: ["**/+(*.)+(spec).+(ts)"],
  setupFilesAfterEnv: ["<rootDir>/spec/test.setup.ts"],
  collectCoverage: true,
  coverageReporters: ["html", "lcov"],
  coverageDirectory: "coverage",
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions?.paths || {}, {
    prefix: "<rootDir>/",
  }),
};
