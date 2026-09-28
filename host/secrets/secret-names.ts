/** The Bot-secret name rules live in @synapse/shared so the Mac (which stores and lists secrets) and the
 *  box (which puts them in the Bot env) judge a name by the SAME function — bug 56. */
export { RESERVED_NAMES, RESERVED_PREFIXES, RESERVED_SUFFIXES, SECRET_NAME_FORMAT_ERROR, validateSecretName } from "@synapse/shared";
