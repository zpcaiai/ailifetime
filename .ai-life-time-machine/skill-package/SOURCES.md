
# Sources and regulatory watchlist

Last reviewed: **2026-08-14**.  
This file records engineering inputs, not legal advice. Re-check every item before a production launch or material feature change.

## Agent Skills / host compatibility

### OpenAI / Codex

- **Build skills | ChatGPT Learn**  
  https://learn.chatgpt.com/docs/build-skills  
  Used for:
  - `SKILL.md` with `name` and `description`;
  - optional `scripts/`, `references/`, `assets/`, `agents/openai.yaml`;
  - Codex project discovery under `.agents/skills`;
  - `$skill`/`/skills` invocation;
  - `policy.allow_implicit_invocation`.

### Anthropic / Claude Code

- **Extend Claude with skills**  
  https://code.claude.com/docs/en/skills  
  Used for:
  - project Skills under `.claude/skills/<skill>/SKILL.md`;
  - Agent Skills open standard compatibility;
  - explicit `/skill-name` invocation and implicit matching;
  - supporting files and progressive disclosure;
  - project/personal scopes and live change detection.

## China: face, personal information, network data

- **人脸识别技术应用安全管理办法**  
  https://www.cac.gov.cn/2025-03/21/c_1744174262156096.htm  
  Effective 2025-06-01. Engineering implications include purpose, necessity, rights protection, security measures, and assessment of whether product processing falls within the regulation.

- **关于开展人脸识别技术应用备案工作的公告**  
  https://www.cac.gov.cn/2025-05/30/c_1750315544241157.htm  
  States that processors storing face information reaching 100,000 persons must file, with timing requirements. B44 tracks threshold and evidence.

- **个人信息保护合规审计管理办法**  
  https://www.cac.gov.cn/2025-02/14/c_1741233507681519.htm  
  Effective 2025-05-01. B44 includes recurring/triggered audit evidence and control mapping.

- **《个人信息保护合规审计管理办法》实施有关事项答记者问**  
  https://www.cac.gov.cn/2025-05/27/c_1750056480898746.htm  
  Points to practical audit guidance, evidence, working papers, and report templates.

- **网络数据安全管理条例**  
  Official State Council/CAC publication should be checked from the current government source before launch. Effective 2025-01-01. B44/B46 treat network-data governance, incidents, processors, and cross-border considerations as release controls.

- **中华人民共和国个人信息保护法**  
  Use the current official National People’s Congress text. B04/B05/B44 translate consent, sensitive personal information, processors, rights, impact assessments, minimization, retention, and cross-border duties into engineering gates.

- **中华人民共和国民法典：肖像权、隐私权等人格权**  
  Use the current official National People’s Congress text. Legal review must assess photo, deceased-person, family, studio, gift, and public-display scenarios.

## China: generated/synthetic AI content

- **人工智能生成合成内容标识办法**  
  https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm  
  Effective 2025-09-01 with the supporting mandatory standard. B10/B16/B17/B44 require visible and implicit labels, metadata/provenance, propagation, verification, and non-removal.

- **《人工智能生成合成内容标识办法》答记者问**  
  https://www.cac.gov.cn/2025-03/14/c_1743654685896173.htm

- **Enforcement example: 生成合成内容标识违法问题**  
  https://www.cac.gov.cn/2026-04/28/c_1779119736411711.htm  
  Used as evidence that labelling controls must be operational rather than a documentation-only promise.

- **2026 AI application governance activity**  
  https://www.cac.gov.cn/2026-07/06/c_1785081384384987.htm  
  Highlights enforcement focus including filing/registration, safety filtering, data issues, labels, impersonation, and minors.

## China: generative AI filing/registration/public disclosure

- **2025 full-year filing notice**  
  https://www.cac.gov.cn/2026-01/09/c_1769688009588554.htm

- **2026 January–February filing notice**  
  https://www.cac.gov.cn/2026-03/17/c_1775482074695536.htm

- **2026 March–April filing notice**  
  https://www.cac.gov.cn/2026-05/13/c_1780413225190669.htm

These notices state that applications directly calling filed models through APIs or other means may need local registration, and deployed applications should prominently disclose model name and filing/registration identifiers where applicable. B12/B17/B44 keep a model registry and launch gate.

## China: anthropomorphic interaction / future-self

- **人工智能拟人化互动服务管理暂行办法**  
  https://www.cac.gov.cn/2026-04/10/c_1777558395023172.htm  
  Effective 2026-07-15. B23/B44 implement persistent AI identity disclosure, dependency safeguards, minors restrictions, safety monitoring, crisis exit, memory/user-control, and operational governance.

- **答记者问**  
  https://www.cac.gov.cn/2026-04/10/c_1777558395284407.htm

Future-self dialogue is optional and high risk. It stays feature-flagged until legal, safety, child-protection, crisis, and incident-response review is complete.

## China: minors

- **可能影响未成年人身心健康的网络信息分类办法**  
  https://www.cac.gov.cn/2026-01/23/c_1770728780862340.htm  
  Effective 2026-03-01. B21/B44 cover inappropriate use of minors’ images, generative-AI content risks, private defaults, and stricter review.

- Also review the current **未成年人网络保护条例**, **个人信息保护法** provisions relating to minors, app-store age rules, advertising rules, and target-region guardian-consent requirements.

## Payments, insurance, health, consumer, and commerce

Before launch, obtain current professional review for:

- payment provider and PCI scope;
- consumer rights, pricing display, auto-renewal, refund and e-commerce obligations;
- invoice/tax and cross-border settlement;
- print/fulfillment vendor processing;
- advertising and endorsements;
- insurance solicitation, distribution, retirement education, licensed advice, unfair discrimination, and recordkeeping;
- medical/health claims;
- accessibility;
- biometric and AI laws outside China;
- deceased-person/publicity/personality rights;
- international data transfers and subprocessors.

## Technical standards to consider

Depending on launch region and providers:

- C2PA / Content Credentials for provenance;
- current GB 45438-2025 implementation guidance for generated/synthetic labels;
- OWASP ASVS, API Security Top 10, MASVS where applicable;
- NIST SSDF / SLSA / SBOM and artifact provenance;
- OpenTelemetry semantic conventions;
- WCAG;
- PCI DSS boundary;
- ISO 27001/27701 or equivalent control mappings if required by enterprise partners.

## Update rule

B44 must add a dated regulatory delta before each release candidate:

```text
source
→ publication/effective date
→ applicability decision
→ affected data flow/feature
→ engineering control
→ evidence
→ legal/compliance owner
→ next review
```

A regulation or contract change that alters face processing, labels, minors, future-self interaction, model filing, data location, payment, insurance use, or deletion blocks the affected feature until the control matrix is updated and validated.


## Agent Skills package format

- OpenAI Codex Skills documentation: repository skills use `.agents/skills/<skill>/SKILL.md`; a skill directory may include `scripts`, `references`, `assets`, and `agents/openai.yaml`.
- Anthropic Claude Code Skills documentation: project skills use `.claude/skills/<skill>/SKILL.md`; supporting files should be split out and loaded progressively.

All laws, platform policies, prices, provider APIs and regional compliance assumptions must be rechecked at implementation and launch time.
