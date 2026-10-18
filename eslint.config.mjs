// ESLint flat config. No `globals` package on purpose: the runtime globals are
// listed explicitly, so `npm run lint` works without installing anything beyond
// ESLint itself.
const BROWSER_GLOBALS = [
  'window', 'document', 'navigator', 'location', 'screen', 'console', 'localStorage', 'sessionStorage',
  'fetch', 'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader', 'Image', 'Node',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DragEvent', 'DataTransfer', 'MutationObserver',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'getComputedStyle', 'matchMedia', 'atob', 'btoa', 'AbortSignal', 'crypto', 'self',
  'DOMParser', 'XMLSerializer', 'NodeList', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement'
]

const browserGlobals = Object.fromEntries(BROWSER_GLOBALS.map((name) => [name, 'readonly']))

// The extension is written as classic scripts (`<script src>` plus an MV3
// service worker), so `sourceType: script` and an explicit global list is the
// accurate model. Vendored libraries are excluded: they are not ours to lint and
// account for every "unsafe assignment" finding in the AMO validator.
export default [
  {
    ignores: [
      '**/js/*.min.js',
      '**/js/de.js',
      '**/js/es.js',
      '**/js/fr.js',
      '**/js/ja.js',
      '**/js/ko.js',
      '**/js/zh-cn.js',
      '**/js/relativeTime.js',
      'node_modules/**'
    ]
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...browserGlobals,
        process: 'readonly',
        Buffer: 'readonly',
        WebSocket: 'readonly',
        __dirname: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
    }
  },
  {
    files: ['**/js/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        chrome: 'readonly',
        browser: 'readonly',
        $: 'readonly',
        jQuery: 'readonly',
        dayjs: 'readonly',
        ViewImage: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
]
