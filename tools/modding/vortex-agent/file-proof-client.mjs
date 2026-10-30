// Both module systems use one implementation and the same fixed runtime closure.
import client from './file-proof-client.cjs';
export const { createFileProofClient, _createFileProofClientForTests } = client;
