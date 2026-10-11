import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Tests resolve the installed DSH's modules; the plugin has no downloaded build inputs.
const runtime = process.env.DSH_TEST_RUNTIME ?? '/storage/Users/currentUser/.oheco/packages/nodejs/24.21.0-ohos.1/lib/node_modules/@deepseek-ai/dsh/runtime';
const parentURL = pathToFileURL(path.join(runtime, 'package.json')).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@earendil-works/') || specifier === 'zod') {
    return next(specifier, { ...context, parentURL });
  }
  return next(specifier, context);
} });
