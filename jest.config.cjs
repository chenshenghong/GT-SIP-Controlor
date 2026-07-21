/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@/(.*)$': '<rootDir>/src/renderer/$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: {
          esModuleInterop: true,
          module: 'commonjs',
          baseUrl: '.',
          skipLibCheck: true,
          paths: {
            '@shared/*': ['src/shared/*'],
            '@/*': ['src/renderer/*'],
          },
        },
      },
    ],
  },
}
