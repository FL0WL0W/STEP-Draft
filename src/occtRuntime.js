import ocFullWasm from 'opencascade.js/dist/opencascade.full.wasm';

let openCascadePromise;

async function initOpenCascade() {
  globalThis.__filename = globalThis.__filename || '/opencascade.full.js';
  globalThis.__dirname = globalThis.__dirname || '/';

  const { default: ocFullJS } = await import('opencascade.js/dist/opencascade.full.js');

  return new Promise((resolve, reject) => {
    new ocFullJS({
      locateFile(path) {
        if (path.endsWith('.wasm')) {
          return ocFullWasm;
        }

        return path;
      }
    }).then(resolve, reject);
  });
}

export function getOpenCascade() {
  if (!openCascadePromise) {
    openCascadePromise = initOpenCascade();
  }

  return openCascadePromise;
}

export function makeInstance(oc, baseName, args = []) {
  for (let suffix = 1; suffix <= 40; suffix += 1) {
    const ctor = oc[`${baseName}_${suffix}`];

    if (!ctor) {
      continue;
    }

    try {
      return new ctor(...args);
    } catch {
      // Try the next overload.
    }
  }

  const ctor = oc[baseName];
  if (ctor) {
    return new ctor(...args);
  }

  throw new Error(`OpenCascade.js does not expose ${baseName}.`);
}

export function callAny(target, names, args = []) {
  for (const name of names) {
    const methodNames = [name];

    for (let suffix = 1; suffix <= 40; suffix += 1) {
      methodNames.push(`${name}_${suffix}`);
    }

    for (const methodName of methodNames) {
      if (typeof target?.[methodName] !== 'function') {
        continue;
      }

      try {
        return target[methodName](...args);
      } catch {
        // Try the next overload.
      }
    }
  }

  throw new Error(`OpenCascade.js method missing: ${names.join(', ')}.`);
}

export function callAnyArgs(target, names, argLists) {
  const errors = [];

  for (const args of argLists) {
    try {
      return callAny(target, names, args);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  throw new Error(`OpenCascade.js method missing: ${names.join(', ')}. ${errors.join(' | ')}`);
}

export function tryCallAnyArgs(target, names, argLists) {
  try {
    return { called: true, value: callAnyArgs(target, names, argLists) };
  } catch {
    return { called: false, value: undefined };
  }
}

export function statusValue(status) {
  if (typeof status === 'number') {
    return status;
  }

  if (typeof status?.value === 'number') {
    return status.value;
  }

  return Number(status);
}

export function enumValue(oc, groupName, valueName) {
  return oc[valueName] || oc[groupName]?.[valueName];
}

export function dereferenceHandle(value) {
  if (value && typeof value.get === 'function') {
    return value.get();
  }

  return value;
}
