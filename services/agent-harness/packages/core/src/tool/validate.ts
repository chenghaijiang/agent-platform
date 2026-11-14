/** Minimal JSON-Schema subset validator — enough for tool inputs without an ajv dependency. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateAgainstSchema(value: unknown, schema: any, path = "input"): ValidationResult {
  const errors: string[] = [];
  walk(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function walk(value: unknown, schema: any, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const type = schema.type;

  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req} is required`);
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(props)) {
      if (key in obj) walk(obj[key], child, `${path}.${key}`, errors);
    }
    return;
  }

  if (type === "string") {
    if (typeof value !== "string") errors.push(`${path} must be a string`);
    else if (schema.minLength != null && value.length < schema.minLength)
      errors.push(`${path} must be at least ${schema.minLength} chars`);
    return;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${path} must be a number`);
    else if (type === "integer" && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, errors));
    return;
  }
  if (schema.enum) {
    if (!schema.enum.includes(value)) errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }
}
