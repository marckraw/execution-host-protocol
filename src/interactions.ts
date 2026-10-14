/**
 * Bounds on a structured choice request (`interactions.structured`,
 * MAR-4002): an `input-request` item's `request` of kind `choice`. A reader
 * keeps what is within them and drops the rest, never the item.
 *
 * Chosen with headroom over what the providers ask with today: Claude Code's
 * AskUserQuestion takes 1 to 4 questions of 2 to 4 options, Codex's
 * `request_user_input` 1 to 3 questions of 2 to 3 options, and both tell the
 * model a header is 12 characters or fewer. Neither bounds any other text.
 * Lengths are in UTF-16 code units.
 */

/** Questions in one request; a request with more is dropped whole. */
export const EXECUTION_INTERACTION_QUESTIONS_MAX_COUNT = 8;
/** Options in one question; later ones are dropped. */
export const EXECUTION_INTERACTION_OPTIONS_MAX_COUNT = 16;
/** A question's text. */
export const EXECUTION_INTERACTION_QUESTION_MAX_LENGTH = 4_000;
/**
 * A question's `id`, which an answer's `questionId` names. As long as a
 * question's text: AskUserQuestion gives a question no id, so agents-daemon
 * uses its text as one.
 */
export const EXECUTION_INTERACTION_QUESTION_ID_MAX_LENGTH =
  EXECUTION_INTERACTION_QUESTION_MAX_LENGTH;
/** A question's `header`, the short chip shown beside it. */
export const EXECUTION_INTERACTION_HEADER_MAX_LENGTH = 64;
/** An option's `label`, which an answer's `values` names. */
export const EXECUTION_INTERACTION_LABEL_MAX_LENGTH = 256;
/** An option's `description`. */
export const EXECUTION_INTERACTION_DESCRIPTION_MAX_LENGTH = 2_000;
/** An option's `preview`: a mockup or a code snippet. */
export const EXECUTION_INTERACTION_PREVIEW_MAX_LENGTH = 8_000;
