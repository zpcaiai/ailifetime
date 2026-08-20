
# Threat model

## Scope

- Feature/Batch:
- Components:
- Data:
- Actors:
- Trust boundaries:
- External providers:
- Excluded scope and reason:

## Assets

Include source media, derived media, face features, consent, child data, future-self memory, accounts, payment, partner data, keys, provenance, and audit.

## Data-flow diagram

Attach a versioned diagram and link each edge to a purpose, retention class, encryption, and subprocessor.

## Threats

| ID | Threat | Actor | Preconditions | Impact | Existing control | Required mitigation | Test/evidence | Owner |
|---|---|---|---|---|---|---|---|---|

Minimum scenarios:

- horizontal/tenant authorization bypass;
- consent spoofing/withdrawal race;
- non-consensual deepfake/public-figure abuse;
- child image misuse;
- object-store/share-token exposure;
- provider retention/training;
- payment/gift/referral fraud;
- internal employee misuse;
- deletion/backup resurrection;
- AI-label removal/provenance forgery;
- future-self dependency/crisis failure;
- supply-chain/Agent-generated malicious code.

## Abuse cases

Describe user-visible refusal, evidence handling, appeal, and operational escalation.

## Residual risk

Every high/critical residual risk needs an authorized owner, expiry, compensating control, and release decision.
