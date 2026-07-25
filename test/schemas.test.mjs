import assert from "node:assert/strict";
import test from "node:test";
import * as schemas from "../src/schemas.mjs";

test("every strict object schema requires every declared property", () => {
  for (const [name, wrapper] of Object.entries(schemas)) {
    assertStrictObjects(wrapper.schema, name);
  }
});

function assertStrictObjects(schema, location) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object" && schema.additionalProperties === false) {
    const properties = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    assert.deepEqual(
      required,
      properties,
      `${location} must require every property for provider strict mode`,
    );
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required") continue;
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        assertStrictObjects(entry, `${location}.${key}[${index}]`),
      );
    } else {
      assertStrictObjects(value, `${location}.${key}`);
    }
  }
}
