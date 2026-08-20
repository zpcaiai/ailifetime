# External evidence gates

Code completion and local verification do not certify external organizations or production systems. The following statuses remain outside the local implementation:

| Gate | Local evidence | Required external evidence | Current status |
|---|---|---|---|
| AI media providers | Port contracts, consent/routing tests, synthetic adapter | Approved provider account, regional retention terms, licensed evaluation set and measured quality/safety results | NOT_CERTIFIED |
| Payments and IAP | Token-only contract, signature/deduplication logic, balanced ledger tests | Provider sandbox account, Apple/Google server notifications, WeChat/Alipay merchant verification and reconciliation | NOT_CERTIFIED |
| Tax, invoice and fapiao | Immutable invoice/credit-note and ledger rules | Jurisdiction-specific tax review, accredited invoicing connection and accounting sign-off | NOT_CERTIFIED |
| Mobile and mini-program stores | Secure client modules, privacy/release gates | Signed builds, store review, WeChat review account and approval | NOT_CERTIFIED |
| Physical fulfillment | Print/vendor/shipping/inventory handlers and sandbox port | Contracted printer/carrier, test production, deletion SLA and claims reconciliation | NOT_CERTIFIED |
| Legal and regulated channels | High-impact-use prohibition and evidence requirements | Applicable counsel review, filed/approved policies and partner-specific regulatory review | NOT_CERTIFIED |
| Security and accessibility | Automated negative tests and accessible local UI | Independent penetration test, manual assistive-technology audit and remediation verification | NOT_CERTIFIED |
| Multi-region/DR | Residency/failover policy handlers and database contract | Deployed regions, measured restore/failover drills, RTO/RPO and data-residency evidence | NOT_CERTIFIED |
| Production launch | Staged-rollout and rollback state machines | Named approvers, frozen artifacts, live monitoring, incident staffing and observed rollout waves | NOT_RUN |

B127 must not issue a production certificate unless all profile-required completion reports and the external evidence above are independently verified. A local capability result is never equivalent to a legal, accounting, security, partner or release approval.
