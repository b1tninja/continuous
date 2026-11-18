/**
 * RFC 9207 authorization server issuer identification, client side.
 *
 * The expected issuer is the `issuer` of the authorization server metadata the
 * authorization request was built from, recorded before the browser is opened.
 * The comparison is a simple string comparison (RFC 9207 section 2.4).
 */
export interface IssuerCheckInput {
  /** The `iss` parameter of the authorization response, if present. */
  iss: string | undefined;
  /** Issuer from the metadata used for the request; undefined if unknown. */
  expectedIssuer: string | undefined;
  /** `authorization_response_iss_parameter_supported` from that metadata. */
  issParameterSupported: boolean;
}

export type IssuerCheck = { ok: true } | { ok: false; reason: string };

export function checkAuthorizationIssuer(input: IssuerCheckInput): IssuerCheck {
  const { iss, expectedIssuer, issParameterSupported } = input;
  if (iss === undefined) {
    // RFC 9207 2.4: responses without `iss` from a server that supports the
    // parameter MUST be rejected.
    return issParameterSupported
      ? {
          ok: false,
          reason:
            "The authorization response has no `iss` parameter, but the authorization server says it sends one. The response was rejected.",
        }
      : { ok: true };
  }
  if (!expectedIssuer) {
    // Nothing to compare with: do not guess, do not proceed.
    return {
      ok: false,
      reason:
        "The authorization response carries an `iss` parameter but the expected issuer is unknown. The response was rejected.",
    };
  }
  if (iss !== expectedIssuer) {
    return {
      ok: false,
      reason: `The authorization response came from a different issuer than the one the request was sent to (got ${JSON.stringify(iss)}, expected ${JSON.stringify(expectedIssuer)}). The response was rejected.`,
    };
  }
  return { ok: true };
}
