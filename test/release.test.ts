import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRelease,
  resolveGitRelease,
  detectReleaseFromEnv,
  isNodeRuntime,
  _resetReleaseCache,
  type GitRunner,
} from '../src/release';

afterEach(() => {
  _resetReleaseCache();
});

function fakeGit(map: Record<string, string | null | Error>): GitRunner {
  return (args: string[]) => {
    const key = args.join(' ');
    const v = map[key];
    if (v instanceof Error) throw v;
    return v ?? null;
  };
}

describe('detectReleaseFromEnv', () => {
  it('prefers ALLSTAK_RELEASE over platform vars', () => {
    expect(detectReleaseFromEnv({ ALLSTAK_RELEASE: 'r1', RAILWAY_GIT_COMMIT_SHA: 'abc' })).toBe('r1');
  });
  it('falls back through platform vars', () => {
    expect(detectReleaseFromEnv({ RAILWAY_GIT_COMMIT_SHA: 'rw' })).toBe('rw');
    expect(detectReleaseFromEnv({ RENDER_GIT_COMMIT: 'rd' })).toBe('rd');
    expect(detectReleaseFromEnv({ VERCEL_GIT_COMMIT_SHA: 'v' })).toBe('v');
    expect(detectReleaseFromEnv({ GIT_COMMIT: 'gc' })).toBe('gc');
    expect(detectReleaseFromEnv({ GIT_SHA: 'gs' })).toBe('gs');
    expect(detectReleaseFromEnv({ SOURCE_VERSION: 'sv' })).toBe('sv');
  });
  it('ignores empty / whitespace and trims', () => {
    expect(detectReleaseFromEnv({ ALLSTAK_RELEASE: '   ', RAILWAY_GIT_COMMIT_SHA: '  v ' })).toBe('v');
    expect(detectReleaseFromEnv({})).toBeUndefined();
  });
});

describe('resolveGitRelease', () => {
  it('uses git describe output', () => {
    expect(resolveGitRelease(fakeGit({ 'describe --tags --always --dirty': 'v1.2.3-4-gabcdef' }))).toBe('v1.2.3-4-gabcdef');
  });
  it('keeps the --dirty suffix from describe', () => {
    expect(resolveGitRelease(fakeGit({ 'describe --tags --always --dirty': 'v1.0.0-dirty' }))).toBe('v1.0.0-dirty');
  });
  it('falls back to short sha (clean tree)', () => {
    expect(
      resolveGitRelease(
        fakeGit({ 'describe --tags --always --dirty': '', 'rev-parse --short HEAD': 'deadbee', 'status --porcelain': '' }),
      ),
    ).toBe('deadbee');
  });
  it('appends -dirty when status reports a dirty tree', () => {
    expect(
      resolveGitRelease(
        fakeGit({ 'describe --tags --always --dirty': null, 'rev-parse --short HEAD': 'deadbee', 'status --porcelain': ' M a.ts' }),
      ),
    ).toBe('deadbee-dirty');
  });
  it('undefined when runner yields nothing', () => {
    expect(resolveGitRelease(fakeGit({}))).toBeUndefined();
  });
  it('graceful when the runner throws', () => {
    expect(resolveGitRelease(() => { throw new Error('ENOENT'); })).toBeUndefined();
  });
});

describe('resolveRelease — priority order', () => {
  it('1. explicit wins', () => {
    expect(resolveRelease({ explicit: 'x', env: { ALLSTAK_RELEASE: 'e' }, gitRunner: fakeGit({ 'describe --tags --always --dirty': 'g' }), version: '9' })).toBe('x');
  });
  it('2. env beats git + version', () => {
    expect(resolveRelease({ env: { RAILWAY_GIT_COMMIT_SHA: 'rw' }, gitRunner: fakeGit({ 'describe --tags --always --dirty': 'g' }), version: '9' })).toBe('rw');
  });
  it('3. git beats version', () => {
    expect(resolveRelease({ env: {}, gitRunner: fakeGit({ 'describe --tags --always --dirty': 'g' }), version: '9' })).toBe('g');
  });
  it('4. version fallback', () => {
    expect(resolveRelease({ env: {}, gitRunner: fakeGit({}), version: '9' })).toBe('9');
  });
  it('opt-out disables git + version (env still honored)', () => {
    expect(resolveRelease({ autoDetectRelease: false, env: {}, gitRunner: fakeGit({ 'describe --tags --always --dirty': 'g' }), version: '9' })).toBe('');
    expect(resolveRelease({ autoDetectRelease: false, env: { GIT_SHA: 'gs' }, version: '9' })).toBe('gs');
  });
  it('caches the git lookup', () => {
    let calls = 0;
    const runner: GitRunner = (args) => { calls++; return args[0] === 'describe' ? 'g' : null; };
    expect(resolveRelease({ env: {}, gitRunner: runner })).toBe('g');
    expect(resolveRelease({ env: {}, gitRunner: runner })).toBe('g');
    expect(calls).toBe(1);
  });
});

describe('runtime guard', () => {
  it('isNodeRuntime true under vitest', () => {
    expect(isNodeRuntime()).toBe(true);
  });
});
