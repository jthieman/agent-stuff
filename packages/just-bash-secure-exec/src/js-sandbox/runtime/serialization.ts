export function assertSerializable<T>(value: T): T {
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Value is not serializable");
  }

  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError("Value is not serializable", {
      cause: error,
    });
  }
}

export function assertJsonSerializable<T>(value: T): T {
  validateJsonValue(value, "value", new Set<object>());

  return JSON.parse(JSON.stringify(value)) as T;
}

function validateJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }

    throw new TypeError(`${path} is not JSON-serializable: number must be finite`);
  }

  if (Array.isArray(value)) {
    validateJsonArray(value, path, seen);
    return;
  }

  if (typeof value === "object") {
    validateJsonObject(value, path, seen);
    return;
  }

  throw new TypeError(`${path} is not JSON-serializable: ${typeof value} is unsupported`);
}

function validateJsonArray(value: unknown[], path: string, seen: Set<object>): void {
  assertNotCircular(value, path, seen);

  const indexKeys = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${path} is not JSON-serializable: sparse arrays are unsupported`);
    }

    indexKeys.add(String(index));
    validateJsonValue(value[index], `${path}[${index}]`, seen);
  }

  for (const key of Object.keys(value)) {
    if (!indexKeys.has(key)) {
      throw new TypeError(`${path} is not JSON-serializable: array properties are unsupported`);
    }
  }

  seen.delete(value);
}

function validateJsonObject(value: object, path: string, seen: Set<object>): void {
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} is not JSON-serializable: object must be plain`);
  }

  assertNotCircular(value, path, seen);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new TypeError(
        `${path} is not JSON-serializable: only enumerable string keys are supported`,
      );
    }
  }

  for (const [key, child] of Object.entries(value)) {
    validateJsonValue(child, `${path}.${key}`, seen);
  }

  seen.delete(value);
}

function assertNotCircular(value: object, path: string, seen: Set<object>): void {
  if (seen.has(value)) {
    throw new TypeError(`${path} is not JSON-serializable: circular references are unsupported`);
  }

  seen.add(value);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
