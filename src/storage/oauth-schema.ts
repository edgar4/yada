import { z } from "zod";
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  OAuthMetadataSchema,
  OpenIdProviderMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
export const oauthSessionSchema = z.object({
  client: OAuthClientInformationSchema.loose().optional(),
  tokens: OAuthTokensSchema.loose().optional(),
  discovery: z
    .object({
      authorizationServerUrl: z.string(),
      authorizationServerMetadata: z
        .union([OAuthMetadataSchema, OpenIdProviderMetadataSchema])
        .optional(),
      resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
      resourceMetadataUrl: z.string().optional(),
    })
    .loose()
    .transform(
      ({
        authorizationServerMetadata,
        resourceMetadata,
        resourceMetadataUrl,
        ...rest
      }) => ({
        ...rest,
        ...(authorizationServerMetadata ? { authorizationServerMetadata } : {}),
        ...(resourceMetadata ? { resourceMetadata } : {}),
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      }),
    )
    .optional(),
  pending: z
    .object({
      state: z.string(),
      expiresAt: z.number(),
      verifier: z.string().optional(),
    })
    .transform(({ verifier, ...rest }) => ({
      ...rest,
      ...(verifier === undefined ? {} : { verifier }),
    }))
    .optional(),
});
