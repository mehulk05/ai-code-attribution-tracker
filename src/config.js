// Central configuration: file scope, tool fingerprints, identity merging.
// Tweak here without touching the analysis engine.

// Files that count as authored source. Extend per project.
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.scss', '.html', '.java', '.py'];

// Of those, the ones we actually run AI-style fingerprinting on.
// Markup/styles carry little tool signal, so they count toward LOC but not detection.
export const DETECTION_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.java', '.py'];

// Path fragments to drop entirely (regex, tested against the POSIX path).
export const EXCLUDE_PATTERNS = [
  /node_modules\//,
  /\/dist\//,
  /\/build\//,
  /\.spec\.(ts|js)$/,
  /\.test\.(ts|js)$/,
  /\/assets\//,
  /\.min\./,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.d\.ts$/,
];

// ── Tool fingerprints ────────────────────────────────────────────────────────
// Each signature is a per-line regex. A file's score = number of matching lines.
export const SIGNATURES = {
  antigravity: {
    label: 'Antigravity / Gemini',
    perLine: [
      /^\s*(\/\/|\/\*|\*|#) ?={6,}/,        // banner divider comments  // =======
      /^\s*(\/\/|#) [A-Z][A-Z ]{4,}$/,       // ALL-CAPS section headers
    ],
    // Python-style docstring placed INSIDE the function body (Gemini tell).
    multiline: [/\)\s*\{\s*\n\s*\/\*\*/],
  },
  claude: {
    label: 'Claude',
    perLine: [
      /^\s*\/\/ ?\d+\.\s/,                    // numbered step comments // 1.  // 2.
    ],
    // JSDoc-above density is handled separately (count of /** blocks).
    jsdocStrongThreshold: 8,
  },
};

// Human tells — used only to LOWER confidence on a file, never to add AI score.
export const HUMAN_TELLS = [
  /dyanamic|dyanmic|recieve|seperat|calulate|tolltip|tooltop|baisc|widht|hieght|lenght|adress|fucntion|retrun/i,
];

// ── Identity merging ─────────────────────────────────────────────────────────
// Map any author email OR name fragment (lowercased substring) to a canonical person.
// Edit this per organisation. Bots listed in BOTS are excluded from human authorship.
export const IDENTITY_RULES = [
  { canonical: 'Mehul Kothari', match: ['mehul', 'kothari'] },
  { canonical: 'Dev Sharma', match: ['devsharma', 'devsharmasoe'] },
  { canonical: 'Manish Patidar', match: ['manish'] },
  { canonical: 'Sai Somanath', match: ['sai.somanath', 'sai somanath'] },
  { canonical: 'Anurag Kothari', match: ['anurag', 'anukothari'] },
  { canonical: 'Lalit Suryan', match: ['lalit'] },
  { canonical: 'Yogesh Paygude', match: ['yogesh'] },
  { canonical: 'Soham Sanghrajka', match: ['soham'] },
  { canonical: 'Harish Verma', match: ['harish', 'harsish'] },
  { canonical: 'Monika Desai', match: ['monika'] },
];

export const BOTS = ['coderabbit', 'bots.bitbucket.org', 'dependabot', 'renovate'];

export function canonicalIdentity(emailOrName) {
  const k = (emailOrName || '').toLowerCase();
  if (BOTS.some((b) => k.includes(b))) return { name: 'Bot / Reviewer', isBot: true };
  for (const rule of IDENTITY_RULES) {
    if (rule.match.some((m) => k.includes(m))) return { name: rule.canonical, isBot: false };
  }
  return { name: emailOrName || 'unknown', isBot: false };
}
