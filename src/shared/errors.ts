/** Historical name retained so existing seller callers keep the same error type. */
export class CommerceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CommerceError';
  }
}
