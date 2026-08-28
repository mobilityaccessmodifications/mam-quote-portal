import config, { validateConfig } from './src/config.js';
import { createApp } from './src/app.js';

// Local development server. On Vercel the app is served by api/index.js instead —
// this file (and its listen()/fail-fast) only runs under `npm start` / `npm run dev`.
const app = createApp(config);

const problems = validateConfig(config);
if (problems.length) {
  // Refuse to start in a misconfigured state rather than booting "healthy" while
  // lookups silently fail or the API ships an enumerable / spoofable configuration.
  // (Mock mode with ONLY credential gaps is fine — those are filtered by validateConfig.)
  const fatal = !config.mockMode || config.trustProxyUnsafe;
  const heading = fatal ? '\n  ✗ Refusing to start — fix these configuration problems:' : '\n  Configuration warnings:';
  console[fatal ? 'error' : 'warn'](heading);
  for (const p of problems) console[fatal ? 'error' : 'warn']('   - ' + p);
  if (fatal) {
    console.error('  (Tip: set MOCK_MODE=true to run with sample data and no credentials.)\n');
    process.exit(1);
  }
  console.warn('');
}

app.listen(config.port, () => {
  const mode = config.mockMode ? 'MOCK (sample data)' : 'LIVE (AroFlo API)';
  console.log(`\n  Mobility Access — Quote Status portal`);
  console.log(`  Mode:  ${mode}`);
  console.log(`  URL:   http://localhost:${config.port}\n`);
});
