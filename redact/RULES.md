# Detection rules

Every rule lives in `hooks/rules.ts`. Secret rules always run. PII rules run only when PII redaction is on. Any rule can be switched off by its id.

How a scan settles conflicts:

- A hit covers only the value (the capture group), not the key name or quotes around it.
- When two hits overlap, the leftmost wins, then the longest, then the rule listed first below.
- Text inside an existing `[REDACTED:LABEL#hex]` placeholder is never matched again.
- A secret wrapped in base64 is reported once, over the whole base64 run, with the label of the rule that found it inside (see below).
- Every quantifier is bounded, and so is the base64 decode pass, so a 2 MB blob of random base64 or of near-miss keys scans in well under a second.

All examples below are fake. They have the right shape and nothing else.

my-claude-mods: the examples are cut to their first characters so GitHub push protection does not read them as real keys.

## Secret rules

| id | label | kind | what it catches | example that matches | source |
| --- | --- | --- | --- | --- | --- |
| `aws-access-key` | `AWS_KEY` | secret | AWS access key id: `AKIA`, `ASIA`, `ABIA` or `ACCA` plus 16 base32 characters; ids ending in `EXAMPLE` are skipped | `AKIAFAKE…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `aws-secret-key` | `AWS_SECRET` | secret | 40-character AWS secret access key assigned to an `aws_secret_access_key` style name | `aws_secr…` | [AWS docs](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html) |
| `github-token` | `GITHUB_TOKEN` | secret | GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and fine-grained `github_pat_` | `ghp_0123…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `gitlab-pat` | `GITLAB_TOKEN` | secret | GitLab personal access token `glpat-`, including the newer dotted form | `glpat-FA…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `slack-token` | `SLACK_TOKEN` | secret | Slack bot, user, app, refresh and session tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-`) | `xoxb-123…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `slack-webhook` | `SLACK_WEBHOOK` | secret | Slack incoming webhook, workflow and trigger URLs | `https://…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `stripe-live-key` | `STRIPE_KEY` | secret | Stripe live secret and restricted keys (`sk_live_`, `rk_live_`); test keys are left alone | `sk_live_…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `sendgrid-key` | `SENDGRID_KEY` | secret | SendGrid API key: `SG.` plus a 22 and a 43 character segment | `SG.FAKE0…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `twilio-key` | `TWILIO_KEY` | secret | Twilio API key SID: `SK` plus 32 hex characters | `SK012345…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `google-api-key` | `GOOGLE_API_KEY` | secret | Google API key: `AIza` plus 35 characters | `AIzaFAKE…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `google-oauth-secret` | `GOOGLE_OAUTH_SECRET` | secret | Google OAuth client secret: `GOCSPX-` plus 28 characters | `GOCSPX-F…` | [GitHub secret scanning patterns](https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns) |
| `anthropic-key` | `ANTHROPIC_KEY` | secret | Anthropic API, admin and OAuth keys (`sk-ant-api03-`, `sk-ant-admin01-`, `sk-ant-oat01-`) | `sk-ant-a…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `openai-key` | `OPENAI_KEY` | secret | OpenAI keys: `sk-proj-`, `sk-svcacct-`, `sk-admin-`, the `T3BlbkFJ` legacy form and 48-character `sk-` keys | `sk-proj-…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `huggingface-token` | `HF_TOKEN` | secret | Hugging Face access token: `hf_` plus 34 letters | `hf_FAKEf…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `npm-token` | `NPM_TOKEN` | secret | npm access token: `npm_` plus 36 characters | `npm_FAKE…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `pypi-token` | `PYPI_TOKEN` | secret | PyPI upload token: `pypi-AgEIcHlwaS5vcmc` plus at least 50 characters | `pypi-AgE…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `azure-storage-key` | `AZURE_STORAGE_KEY` | secret | Azure storage account key (86 base64 characters plus `==`) after `AccountKey=` or a storage key name | `AccountK…` | [Microsoft Learn](https://learn.microsoft.com/en-us/azure/storage/common/storage-configure-connection-string) |
| `jwt` | `JWT` | secret | JSON Web Token: three base64url segments whose header decodes to JSON with an `alg` field | `eyJhbGci…` | [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519) |
| `private-key` | `PRIVATE_KEY` | secret | Whole PEM private key block (RSA, EC, DSA, OPENSSH, ENCRYPTED, PGP), across lines, with a body of up to 65536 characters | `-----BEG…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `private-key-truncated` | `PRIVATE_KEY` | secret | A private key BEGIN line with no END line, such as the first lines of a key pasted from a terminal: the marker, any `Proc-Type:`, `DEK-Info:` or `Version:` header lines, then at least two base64 lines of 16 to 128 characters, up to the end of the run (at most 2048 lines). Lines may be indented and split by real or JSON-escaped (`\n`) newlines. When the END line is there, `private-key` wins because its hit is longer | `-----BEG…` | [RFC 7468](https://www.rfc-editor.org/rfc/rfc7468) |
| `db-connection-url` | `DB_URL` | secret | postgres, postgresql, mysql, mariadb, mongodb, mongodb+srv, redis, rediss, amqp and amqps URLs that carry `user:password@`; placeholder passwords (`password`, `pass`, `%s`, `%d`, `{{...}}`, `<...>`, `${...}`) and URLs wrapped in `{{ }}` (docs templates) are skipped | `postgres…` | [GitHub secret scanning patterns](https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns) |
| `auth-header` | `AUTH_HEADER` | secret | Value of an `Authorization: Bearer`, `Basic` or `Token` header | `Authoriz…` | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#name-authorization) |
| `generic-secret-quoted` | `SECRET` | secret | Quoted value of 8+ characters assigned to a name containing api key, secret, token, password, passwd, pwd, auth or credential. The name must start a word: after a non-alphanumeric character other than `:`, after a literal `\n`, or as a camelCase hump (`clientSecret`), so `oauth:`, `OAuth` and `force:auth:` do not count. Template slots (`{{...}}`, `<...>`, `__NAME__`, `%s`, `Name=`) are skipped | `password…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |
| `generic-secret` | `SECRET` | secret | Same names and word-start rule with a bare value, which ends at whitespace or a literal `\n`, `\r` or `\t`; skips booleans, placeholders, env references, paths, values under 3.0 bits per character of entropy and code: member chains (`jose.base64url.decode`), optional chains (`options?.auth`) and type names (`Uint8Array`) | `API_KEY=…` | [gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) |

## Base64-wrapped secrets

After the rules above, `scan()` makes one decode pass. It takes up to 200 runs of the base64 alphabet (standard or url-safe, not mixed) of 24 to 8192 characters, padded to a multiple of 4 or unpadded url-safe. It decodes each one and keeps it only when at least 90% of the decoded bytes are printable ASCII. Then it runs only the prefix-anchored rules on the decoded text: `aws-access-key`, `github-token`, `gitlab-pat`, `slack-token`, `slack-webhook`, `stripe-live-key`, `sendgrid-key`, `twilio-key`, `google-api-key`, `google-oauth-secret`, `anthropic-key`, `openai-key`, `huggingface-token`, `npm-token`, `pypi-token`, `private-key`, `private-key-truncated`, `db-connection-url` and `jwt`. The generic and PII rules never run on decoded text, because decoded prose would trip them. Images, lockfile integrity hashes and random blobs decode to binary and produce nothing. A JWT is three separate base64url runs, so the `jwt` hit over the whole token wins.

| id | label | kind | what it catches | example that matches | source |
| --- | --- | --- | --- | --- | --- |
| `<rule>-base64`, for example `aws-access-key-base64` | label of the inner rule | secret | One hit over the whole base64 run when the first inner rule, in table order, matches the decoded text. `off` with `aws-access-key-base64` skips only the wrapped form; `off` with `aws-access-key` skips both | `QUtJQUZBS0UyMzQ1VEVTVDY3Njc=` (the AWS example above, run through `base64`) | [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648) |

## PII rules (opt-in)

| id | label | kind | what it catches | example that matches | source |
| --- | --- | --- | --- | --- | --- |
| `email` | `EMAIL` | pii | Email address; skips URL userinfo (`user:token@host`) and asset names like `icon@2x.png` | `jane.doe@example.com` | [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322#section-3.4.1) |
| `payment-card` | `CARD` | pii | 13 to 19 digit card number starting 2 to 6, plain or with one kind of separator, checked with Luhn | `4111 1111 1111 1111` | [Luhn algorithm](https://en.wikipedia.org/wiki/Luhn_algorithm) |
| `aadhaar` | `AADHAAR` | pii | India Aadhaar: 12 digits starting 2 to 9, optional 4-4-4 grouping, checked with Verhoeff | `2345 6789 0124` | [UIDAI](https://uidai.gov.in/en/my-aadhaar/about-your-aadhaar.html) |
| `us-ssn` | `SSN` | pii | US SSN as `xxx-xx-xxxx`; skips area 000, 666 and 900 to 999, group 00, serial 0000 and known published numbers | `234-56-7890` | [SSA](https://www.ssa.gov/employer/randomization.html) |
| `iban` | `IBAN` | pii | IBAN, compact or in groups of four, checked with mod-97 | `GB82WEST12345698765432` | [IBAN](https://en.wikipedia.org/wiki/International_Bank_Account_Number) |
| `india-pan` | `PAN` | pii | India PAN: 5 letters, 4 digits, 1 letter, with a valid holder type (A, B, C, F, G, H, J, L, P, T) as the 4th letter | `ABCPE1234F` | [PAN](https://en.wikipedia.org/wiki/Permanent_account_number) |
| `phone` | `PHONE` | pii | E.164 numbers and common formatted forms with 10 to 15 digits; skips timestamps, dates, IP addresses and digits inside longer runs | `+919876543210` | [ITU E.164](https://www.itu.int/rec/T-REC-E.164) |
