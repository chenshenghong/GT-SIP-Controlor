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
        tsconfig: {
          esModuleInterop: true,
          module: 'commonjs',
          baseUrl: '.',
          // 與 tsconfig.node.json / tsconfig.web.json 的 strict 對齊；缺這行會讓
          // `if (!r.ok)` 這類 discriminated union 的否定窄化失效（TS2339），
          // 見 cfb1210 review finding：isolatedModules/skipLibCheck 是誤診，
          // 真正缺的是 strict。
          strict: true,
          paths: {
            '@shared/*': ['src/shared/*'],
            '@/*': ['src/renderer/*'],
          },
        },
      },
    ],
  },
}
