import { betterAuth, type Account } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { v4 as uuidv4 } from "uuid";

import {
  authAccounts,
  authSessions,
  authVerifications,
  getDatabase,
  profiles,
  type Database,
} from "@invook/database";

export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

const GOOGLE_IDENTITY_ACCOUNT_SCOPE = GOOGLE_IDENTITY_SCOPES.join(",");

export interface InvookAuthConfiguration {
  appUrl: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}

function requireConfigurationValue(value: string, name: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) throw new Error(`${name} is required by @invook/auth.`);
  return normalizedValue;
}

export function stripGlobalGoogleAccountTokens(
  account: Partial<Account> & Record<string, unknown>,
): Partial<Account> & Record<string, unknown> {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: GOOGLE_IDENTITY_ACCOUNT_SCOPE,
  };
}

export function createInvookAuth(
  configuration: InvookAuthConfiguration,
  database: Database = getDatabase(),
) {
  const appUrl = new URL(
    requireConfigurationValue(configuration.appUrl, "APP_URL"),
  );
  if (appUrl.protocol !== "http:" && appUrl.protocol !== "https:") {
    throw new Error("APP_URL must use HTTP or HTTPS.");
  }

  const secret = requireConfigurationValue(
    configuration.secret,
    "BETTER_AUTH_SECRET",
  );
  const googleClientId = requireConfigurationValue(
    configuration.googleClientId,
    "BETTER_AUTH_GOOGLE_CLIENT_ID",
  );
  const googleClientSecret = requireConfigurationValue(
    configuration.googleClientSecret,
    "BETTER_AUTH_GOOGLE_CLIENT_SECRET",
  );

  return betterAuth({
    appName: "Invook",
    baseURL: appUrl.origin,
    basePath: "/v1/auth",
    secret,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: {
        profiles,
        authAccounts,
        authSessions,
        authVerifications,
      },
      transaction: true,
    }),
    advanced: {
      cookiePrefix: "invook",
      database: { generateId: () => uuidv4() },
      useSecureCookies: appUrl.protocol === "https:",
    },
    disabledPaths: ["/link-social"],
    trustedOrigins: [appUrl.origin],
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        accessType: "online",
        prompt: "select_account",
        disableDefaultScope: true,
        scope: [...GOOGLE_IDENTITY_SCOPES],
      },
    },
    user: {
      modelName: "profiles",
      fields: { name: "displayName" },
    },
    session: {
      modelName: "authSessions",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: {
      modelName: "authAccounts",
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: false,
        allowDifferentEmails: false,
      },
    },
    verification: { modelName: "authVerifications" },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => {
            return { data: stripGlobalGoogleAccountTokens(account) };
          },
        },
        update: {
          before: async (account) => {
            return { data: stripGlobalGoogleAccountTokens(account) };
          },
        },
      },
    },
  });
}

export type InvookAuth = ReturnType<typeof createInvookAuth>;
