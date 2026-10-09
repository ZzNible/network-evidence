# Network Evidence MCP — Privacy Notice

**Last updated:** 9 October 2026  
**Service:** [Network Evidence MCP](https://network-evidence-mcp-jrkc26rjga-ew.a.run.app/mcp)  
**Publisher:** ZzNible (independent project; [public source repository](https://github.com/ZzNible/network-evidence))  
**Privacy and support contact:** [GitHub Issues](https://github.com/ZzNible/network-evidence/issues). **Do not post personal or confidential information in public issues.** Request a private contact channel there if needed.

This notice describes the operation of the public, anonymous Network Evidence MCP endpoint. It does not describe what Claude, ChatGPT, Codex or any other connecting application may separately collect, retain or share; consult that application's privacy notice.

## Information processed

The MCP server receives standard protocol messages and the tool arguments you choose to send. Arguments may contain network/deployment identifiers, caller-provided capability snapshots, resolver manifests and requirements. **Only send information you are comfortable sending to a public third-party endpoint.** Do not send credentials, private keys, confidential evidence or personal data.

- **Tool processing:** requests are validated and processed in memory to return fixed declared network profiles, deterministic Discovery classifications over caller-provided data, or pinned historical/synthetic cases. This application does not maintain user accounts, a database of tool inputs or an archive of submitted evidence.
- **Application logs:** the server code logs HTTP method, a normalized route (`/mcp`, `/health` or `(other)`), response status and request duration. Error handling can log error class names. It is designed **not** to log request bodies, tool arguments, client addresses, credentials or headers.
- **Hosting and infrastructure logs:** Google Cloud Run and Cloud Logging can separately record request and technical metadata such as request time, URL, IP address, user agent, response status and latency. These logs are controlled by the hosting infrastructure, not by the MCP tool code. As checked on **9 October 2026**, the Google Cloud Logging `_Default` bucket for this project has a **30-day retention setting**. Other platform/security or audit logs can be subject to different retention policies, and settings can change.
- The MCP endpoint has no sign-in, does not request API keys, and does not deliberately set tracking cookies or build advertising profiles.

## Purpose and legal basis

The service processes requests to provide the tools you invoke. Operational metadata is used to run the service, investigate failures, limit abuse and protect availability. Where GDPR applies, the operational processing is based on the operator's legitimate interests in providing and securing this public technical service, subject to applicable law.

## Sharing and location

The operator uses **Google Cloud Run** and **Google Cloud Logging** as infrastructure providers; the configured service region is `europe-west1` (Belgium). This does not guarantee that every network transit path or Google infrastructure processing activity remains in Belgium. The connecting MCP client and its provider process the data you submit under their own terms. The operator does not sell MCP submissions or use them to target advertising.

## Retention

Tool inputs are handled in process memory and are not intentionally persisted in an application database. Hosting logs use the applicable Google Cloud logging settings; the project's `_Default` retention was 30 days at the date above. Other audit/security records and external client-side copies may have different retention periods. The operator cannot delete records retained independently by connecting applications.

## Your choices and rights

You can avoid sending personal or confidential data; this service does not require it. If privacy law grants you access, correction, deletion or objection rights, contact the publisher through the support link above (without posting personal information publicly). The operator may need additional details to locate relevant infrastructure logs and may be unable to associate anonymous requests with an individual.

## Security and limitations

All three MCP tools are read-only. There is no wallet, private-key handling, transaction signing, submission, RPC lookup, or live chain monitoring. The service applies strict request validation, exact Host/Origin checks and rate/concurrency limits. No online system can promise absolute security or continuous availability.

## Updates

This notice may be updated as the hosted implementation or operational settings change. Changes will appear in this public repository with version history. For security or privacy inquiries use [GitHub Issues](https://github.com/ZzNible/network-evidence/issues) without sharing secrets or sensitive personal data.
