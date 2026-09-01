import assert from "node:assert/strict";
import test from "node:test";

import { encryptGoogleCredential } from "@invook/database";

import {
  getGmailConnectionIdentityError,
  resolveGmailRefreshToken,
} from "./gmail-connections";

test("omitted Google refresh tokens only fall back to this user's own grant", () => {
  const encryptionKey = Buffer.alloc(32, 8).toString("base64");
  const existingAccount = {
    userId: "user-a",
    tokenCiphertext: encryptGoogleCredential(
      {
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: "2030-01-01T00:00:00Z",
        scopes: [],
      },
      encryptionKey,
    ),
  };
  assert.equal(
    resolveGmailRefreshToken({
      userId: "user-a",
      refreshToken: null,
      existingAccount,
      encryptionKey,
    }),
    "refresh-a",
  );
  assert.equal(
    resolveGmailRefreshToken({
      userId: "user-b",
      refreshToken: null,
      existingAccount,
      encryptionKey,
    }),
    null,
  );
  assert.equal(
    resolveGmailRefreshToken({
      userId: "user-b",
      refreshToken: "refresh-b",
      existingAccount: null,
      encryptionKey,
    }),
    "refresh-b",
  );
  assert.equal(
    resolveGmailRefreshToken({
      userId: "user-b",
      refreshToken: null,
      existingAccount: null,
      encryptionKey,
    }),
    null,
  );
});

test("each user's own connection is accepted while reconnect keeps identity and ownership checks", () => {
  for (const userId of ["user-a", "user-b"]) {
    const connection = {
      id: `${userId}-mailbox-a`,
      userId,
      providerAccountId: "gmail-a",
    };
    for (const reconnectAccount of [null, connection]) {
      assert.equal(
        getGmailConnectionIdentityError({
          userId,
          providerAccountId: "gmail-a",
          reconnectAccount,
          existingAccount: connection,
        }),
        null,
      );
    }
    assert.equal(
      getGmailConnectionIdentityError({
        userId,
        providerAccountId: "gmail-c",
        reconnectAccount: connection,
        existingAccount: null,
      }),
      "mailbox_mismatch",
    );
    assert.equal(
      getGmailConnectionIdentityError({
        userId: "someone-else",
        providerAccountId: "gmail-a",
        reconnectAccount: connection,
        existingAccount: connection,
      }),
      "mailbox_mismatch",
    );
  }
});
