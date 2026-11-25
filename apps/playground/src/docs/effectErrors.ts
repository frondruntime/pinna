// The site's docs print the regions of this file (docs/public/guides/errors.md), so
// `bun run typecheck` compiles what the page shows.
import { Box, isPinnaError, Model, Realm } from "@frondruntime/pinna-effect";
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

// Each refused field's path and message. `Model.decode` throws a DecodeError and a
// write a box refuses a ValueRejectedError; each holds the SchemaError as its
// `cause`. Anything else is not a schema's refusal, and is thrown again.
const issuesOf = (error: unknown) => {
  const refused =
    isPinnaError(error, "DecodeError") || isPinnaError(error, "ValueRejectedError")
      ? error.cause
      : undefined;
  if (!Schema.isSchemaError(refused)) {
    throw error;
  }
  return toStandard(refused.issue).issues;
};
// #endregion

// #region read
const realm = Realm.make();
const $signup = Box.schema(realm, Signup, { email: "", password: "correct horse" });

const submit = (input: unknown) => {
  try {
    return { signup: Model.decode(realm, Signup)(input), issues: [] };
  } catch (error) {
    // [{ path: ["password"], message: "Use at least 8 characters" }]
    return { signup: undefined, issues: issuesOf(error) };
  }
};

const editPassword = (password: string) => {
  try {
    Realm.update(realm, (read, write) => {
      write($signup, { ...read($signup), password });
    });
    return [];
  } catch (error) {
    return issuesOf(error);
  }
};

// #endregion

export { $signup, editPassword, issuesOf, realm, submit };
