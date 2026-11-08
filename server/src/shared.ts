// Single import point for the contract shared with the desktop client and the dashboard.
// The file lives in the desktop app; esbuild bundles it into dist/index.js.
export * from '../../windows/src/shared/sync-types'
