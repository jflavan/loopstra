/**
 * Ids for the files people leave for the loop (a request, a message to a session): the time, this
 * process's pid, and a count, so they sort in the order they were made and two processes never make one id.
 */

/** An id newId makes: anything else is never used as a file name. */
export const ID = /^\d{15}-\d+-\d{4,}$/;

let counter = 0;

/** Sorts by when it was made: the time, then this process's count. */
export function newId(): string {
  return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(counter++).toString().padStart(4, "0")}`;
}
