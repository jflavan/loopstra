/*
 * Which paths are tests, for the test-protection hook (templates/hooks/loopstra-protect-tests.ts) and
 * the acceptance step. A foundation module: it imports nothing, since the hook loads it on its own.
 */

/**
 * A test folder (tests/, Tests/, __tests__/, spec/, a .NET App.Tests/, App.Tests.Unit/ or App.UnitTests/), a test file name
 * (a.test.ts, a.spec.ts; _test and _spec only for the runners that use them: add_test.go, calc_test.py, calc_spec.rb;
 * test_calc.py), or a .NET/JVM class name (CalcTests.cs, CalcTest.java) or XCTest's CalcTests.swift. Class names are
 * case-sensitive and need a small letter or digit before Test, so Latest.java and ABTest.java are not tests.
 * `path` is relative to the project, with forward slashes.
 */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|[^/]+\.tests?(\.\w+)?)\//i.test(path)
    || /(^|\/)[^/]+\.\w*Tests?(\.\w+)?\//.test(path)
    || /\.(test|spec)s?\.[a-z0-9]+$|_test\.(go|py|rb|exs|cc|cpp|c|rs)$|_spec\.rb$|(^|\/)test_[^/]+\.py$/i.test(path)
    || /(^|\/)[A-Za-z0-9_]*[a-z0-9](Tests?\.(cs|fs|vb|java|kt|scala)|Tests\.swift)$/.test(path);
}

/**
 * What the acceptance step may write: a test, or a fixture its tests read from a folder no test rule
 * names (Go's testdata/, fixtures/, __fixtures__/, test-utils/ or test-helpers/).
 */
export function isAcceptancePath(path: string): boolean {
  return isTestPath(path) || /(^|\/)(testdata|fixtures|__fixtures__|test-(utils|helpers))\//i.test(path);
}
