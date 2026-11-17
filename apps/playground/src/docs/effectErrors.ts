// The site's docs print the regions of this file (docs/public/guides/errors.md), so
// `bun run typecheck` compiles what the page shows.
import { createRealm, decode, schemaBox, update } from "@frondruntime/pinna-effect";
import { Schema, SchemaIssue } from "effect";

// #region message
// A filter that returns a string fails with that string as its message.
const Password = Schema.String.check(
  Schema.makeFilter((password) => password.length >= 8 || "Use at least 8 characters"),
);

const Signup = Schema.Struct({ email: Schema.String, password: Password });
// #endregion

// #region issues
const toStandard = SchemaIssue.makeFormatterStandardSchemaV1();

// Each refused field's path and message. `decode` throws the SchemaError; a
// write a box refuses throws an Error whose `cause` is the SchemaError.
// Anything else is not a schema's refusal, and is thrown again.
const issuesOf = (error: unknown) => {
  const schemaError = error instanceof Error && !Schema.isSchemaError(error) ? error.cause : error;
  if (!Schema.isSchemaError(schemaError)) {
    throw error;
  }
  return toStandard(schemaError.issue).issues;
};
// #endregion

// #region read
const realm = createRealm();
const $signup = schemaBox(realm, Signup, { email: "", password: "correct horse" });

const submit = (input: unknown) => {
  try {
    return { signup: decode(realm, Signup)(input), issues: [] };
  } catch (error) {
    // [{ path: ["password"], message: "Use at least 8 characters" }]
    return { signup: undefined, issues: issuesOf(error) };
  }
};

const editPassword = (password: string) => {
  try {
    update(realm, (read, write) => {
      write($signup, { ...read($signup), password });
    });
    return [];
  } catch (error) {
    return issuesOf(error);
  }
};

// #endregion

export { $signup, editPassword, issuesOf, realm, submit };
