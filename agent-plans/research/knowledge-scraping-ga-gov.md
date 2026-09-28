For the system you’re describing, I’d treat Georgia law as a stream of **legal events**, not just a collection of documents. You want to know when a bill is introduced, amended, passes a chamber, reaches the governor, is signed/vetoed, becomes effective, when an agency proposes/adopts a rule, and when an appellate court changes the interpretation of existing law.

The good news is that Georgia exposes most of this publicly.

| Source                                             | What to ingest                                                                                   | Why it matters                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Georgia General Assembly**                       | Bills, resolutions, versions, sponsors, committees, actions, votes, effective dates, act numbers | Primary source for the entire legislative lifecycle                   |
| **General Assembly daily documents**               | First Readers, status sheets, calendars, composites                                              | Faster signal for what moved during a legislative day                 |
| **Governor**                                       | Signed bills, vetoes, executive orders                                                           | Confirms final executive action                                       |
| **Georgia Secretary of State Rules & Regulations** | Current administrative rules, final rule filings, monthly bulletins                              | Canonical administrative-regulation source                            |
| **Individual state agencies**                      | Proposed rules, notices, hearings, board adoption                                                | Often the earliest signal of regulatory change                        |
| **Georgia Supreme Court / Court of Appeals**       | Opinions and orders                                                                              | Courts can materially change how statutes/regulations are interpreted |
| **Attorney General**                               | Official/unofficial opinions                                                                     | Important executive-branch legal interpretations                      |
| **Secretary of State Elections**                   | Constitutional amendments/referenda                                                              | Some legal changes ultimately require voter approval                  |

### Georgia General Assembly — your most important source

Start with the General Assembly legislation database:

[Georgia General Assembly legislation search](https://www.legis.ga.gov/legislation?utm_source=chatgpt.com)

Individual legislation pages are excellent. A bill page can expose the title, current and past versions, sponsors, committees, first-reader summary, complete status history, votes, act number, signature date, and effective date. For example, HB 1161's page records events from introduction through House/Senate votes, delivery to the governor, signature, Act 640, and its July 1, 2026 effective date. ([Georgia General Assembly][1])

That lets your ingestion model represent something like:

```text
HB 1161
2026-02-02 introduced
2026-02-19 passed House
2026-03-31 passed Senate
2026-04-10 sent to Governor
2026-05-12 signed
Act 640
2026-07-01 effective
```

That history is much more valuable than simply classifying a bill as `"passed"`.

The site also exposes bill/resolution documents through URLs under `/api/legislation/document/...`. These PDFs are particularly useful because you can preserve **every version of the actual legal text**, rather than continuously overwriting one bill record. The General Assembly also publishes an annual **Summary of General Statutes Enacted**, which includes statewide acts, affected O.C.G.A. sections, descriptions, and effective dates. ([Georgia General Assembly][2])

You should also scrape:

[Georgia legislative calendars and daily documents](https://www.legis.ga.gov/documents?utm_source=chatgpt.com)

The legislature publishes House and Senate First Readers, Status Sheets, Rules Calendars, and Composite documents. ([Georgia General Assembly][3])

During session, I'd poll the structured bill/status data several times per day and treat these daily documents as supplemental confirmation and discovery.

### Governor — signed laws, vetoes and executive orders

Use the governor's legislation pages as a second authoritative confirmation of the final disposition of legislation.

[Governor — legislation](https://gov.georgia.gov/executive-action/legislation?utm_source=chatgpt.com)

The governor separately publishes signed and vetoed legislation. ([Office of the Governor][4]) The 2026 signed-legislation page, for example, provides bill identifiers, descriptions and final PDFs. ([Office of the Governor][5])

You should ingest it independently from the General Assembly. If both sources report that something became law, you now have useful cross-source validation.

Executive orders are another separate event type:

[Georgia Governor — executive orders](https://gov.georgia.gov/executive-action/executive-orders?utm_source=chatgpt.com)

The governor describes executive orders as legal instruments used to carry out the duties of the office and publishes them by year with dates, identifiers, descriptions, and PDFs. ([Office of the Governor][6])

I would therefore distinguish:

```text
statute
executive_order
proclamation
```

rather than grouping all of them under `"law"`.

### Georgia administrative regulations — absolutely essential

This is the other huge data source:

[Rules and Regulations of the State of Georgia](https://rules.sos.ga.gov/?utm_source=chatgpt.com)

The Secretary of State says this database contains rules and regulations filed by state agencies under the Georgia Administrative Procedure Act and is updated as new or amended rules are filed. ([Georgia Rules and Regulations][7])

The hierarchy is convenient for your RAG/indexing model:

```text
Department
  Chapter
    Subject
      Rule
```

For example:

```text
391
391-3
391-3-1
391-3-1-.01
```

The PDF/download area is particularly useful:

[Georgia Rules downloadable departments and bulletins](https://rules.sos.ga.gov/Download_pdf.aspx?utm_source=chatgpt.com)

Georgia publishes downloadable agency rule collections and **monthly administrative bulletins**. The bulletins contain fields such as department, rule number, action, filing date and effective date. ([Georgia Rules and Regulations][8])

That's almost exactly the change feed you're looking for.

One important caveat: as of September 22, 2026, the rules site currently says its compiled rules are current through filings made September 2, 2026. ([Georgia Rules and Regulations][7]) So I would **not rely solely on the compiled rule database for real-time discovery**.

### Proposed agency rules require another crawler

This is probably the trickiest part of the project.

Georgia agencies frequently publish proposed regulations themselves before those regulations make it into the final Secretary of State compilation. The Department of Agriculture's explanation of Georgia's rulemaking process describes a proposal, notice period/public comment, adoption, filing with the Secretary of State, and eventual publication by the Secretary of State. ([Georgia Department of Agriculture][9])

For example, Georgia EPD maintains a very nice structured page showing proposed environmental rules, hearing dates, comment deadlines, board action dates, final action and responses to comments. ([Environmental Protection Division][10])

The Department of Revenue similarly publishes detailed proposed-rule notices containing the affected rule numbers, proposed text, authority, hearing date, comment deadline, synopsis and regulatory-impact analysis. ([Department of Revenue][11])

The Insurance Commissioner publishes its own proposed-rule hearings. ([Insurance & Safety Fire Commission][12]) The State Election Board also has its own proposed-rules page. ([Georgia Secretary of State][13])

So I would create an **agency-source registry** rather than expecting one universal proposed-rule endpoint.

Georgia conveniently gives you a seed list:

[Georgia State Organizations directory](https://georgia.gov/state-organizations?utm_source=chatgpt.com)

That directory enumerates state organizations and agencies. ([Georgia.gov][14])

Your discovery crawler can start there and look on each agency domain for predictable concepts such as `proposed rules`, `rulemaking`, `public notices`, `board meetings`, `notices of intent`, and `regulations`.

That will likely uncover changes **before** the final rule appears at `rules.sos.ga.gov`.

### Judicial branch

Courts aren't "passing laws," but you need them if your end product is supposed to answer:

> "What changed in Georgia law that could affect me?"

A major appellate decision can change the operative interpretation of an existing statute without the statutory text itself changing.

For the Georgia Supreme Court:

[Georgia Supreme Court 2026 opinions](https://www.gasupreme.us/2026-opinions/?utm_source=chatgpt.com)

The court publishes opinions by date and case number and warns that initial opinions may later be modified during reconsideration/editorial processing. ([Gasupreme][15])

There's even a very useful forthcoming-opinions feed:

[Georgia Supreme Court forthcoming opinions](https://www.gasupreme.us/forthcoming-opinions/?utm_source=chatgpt.com)

It announces opinions before their publication date. ([Gasupreme][16])

For the Court of Appeals, I would target the official `gaappeals.gov` / `gaappeals.us` resources where practical but consider maintaining a secondary discovery source such as CourtListener or Justia, then verify important decisions against the official opinion. The state's Reporter of Decisions explains that both Supreme Court and Court of Appeals opinions go through an official publication/editing process. ([Gasupreme][17])

For court documents, store revisions. Don't assume:

```text
caseNumber -> one immutable PDF
```

Instead use:

```text
caseNumber
version
publishedAt
isFinal
contentHash
```

### Attorney General opinions

I'd ingest these too:

[Georgia Attorney General opinions](https://law.georgia.gov/opinions?utm_source=chatgpt.com)

The AG publishes both official and unofficial opinions. Official opinions answer legal questions from the governor or executive departments; other opinions can be issued to legislators, judges, district attorneys and other state officers. ([Office of the Attorney General][18])

These aren't statutes, but some have considerable administrative significance. The Attorney General's office states that its opinions on legal questions concerning Georgia or its agencies are binding on state agencies and departments. ([Office of the Attorney General][19])

So I'd have an `attorney_general_opinion` document type.

### Constitutional amendments and referenda

Don't forget these because they take a different route than normal statutes.

[Georgia proposed constitutional amendments](https://sos.ga.gov/page/proposed-georgia-constitution-amendments?utm_source=chatgpt.com)

The Secretary of State publishes proposed amendments submitted to Georgia voters along with summaries and, where applicable, statewide referendum questions. ([Georgia Secretary of State][20])

Your lifecycle here would look more like:

```text
constitutional_resolution
    ↓
General Assembly approval
    ↓
placed_on_ballot
    ↓
voter_approved / voter_rejected
    ↓
effective
```

That prevents your system from incorrectly telling someone a constitutional proposal became law simply because the legislature passed the enabling resolution.

### I would use Open States as a second ingestion path

For legislation specifically, there's a very useful non-governmental source:

[Open States API v3](https://docs.openstates.org/api-v3/?utm_source=chatgpt.com)

Open States exposes standardized JSON endpoints for bills, people, committees and events. Bills can include actions, versions, documents, sponsorships and votes. ([Open States][21])

I wouldn't make it your legal source of truth. I'd use:

```text
Open States
    ↓
fast normalized discovery
    ↓
Georgia General Assembly
    ↓
authoritative verification + PDFs
```

That's much easier than reverse-engineering every piece of the General Assembly's frontend on day one.

### The data model matters almost as much as the scrapers

I would avoid one giant `documents` table containing only text and embeddings.

Something closer to this will make "what just changed?" queries much easier:

```ts
interface LegalDocument {
  jurisdiction: "GA";
  type:
    | "bill"
    | "bill_version"
    | "act"
    | "executive_order"
    | "proposed_rule"
    | "final_rule"
    | "court_opinion"
    | "ag_opinion"
    | "constitutional_amendment";

  canonicalId: string;
  title: string;

  branch: "legislative" | "executive" | "judicial";

  agency?: string;

  introducedAt?: Date;
  proposedAt?: Date;
  passedAt?: Date;
  adoptedAt?: Date;
  signedAt?: Date;
  filedAt?: Date;
  effectiveAt?: Date;

  status: string;

  sourceUrl: string;
  sourceRetrievedAt: Date;

  contentHash: string;
}
```

Then have a separate immutable event stream:

```ts
interface LegalEvent {
  documentId: string;

  event:
    | "introduced"
    | "amended"
    | "committee_reported"
    | "passed_house"
    | "passed_senate"
    | "sent_to_governor"
    | "signed"
    | "vetoed"
    | "proposed"
    | "public_comment_opened"
    | "adopted"
    | "filed"
    | "effective"
    | "opinion_issued";

  occurredAt: Date;

  sourceUrl: string;
}
```

That's what will eventually let your assistant answer something much better than "here are some recently published PDFs":

> **Changed in the last 48 hours**
> A proposed DOR regulation entered public comment.
> HB XYZ advanced from committee.
> SB ABC was signed but doesn't take effect until January 1.
> Rule 391-X-X became effective today.
> The Georgia Supreme Court issued a decision interpreting O.C.G.A. § X.

And then the next layer can answer **"does this affect me?"** based on topics like homeowner, driver, taxpayer, employer, renter, business owner, professional-license holder, county/city, age group, etc.

One technical recommendation I'd make strongly: **store every source document permanently and content-hash it.** Don't just scrape the current state and overwrite yesterday's copy. Bill substitutes, amended text and rule revisions are exactly where many of the interesting legal changes live.

For the first version, I'd build around **General Assembly + Governor + SOS Rules + agency proposed-rule notices**. Those four will capture the overwhelming majority of actual state legislative/regulatory changes, and then add the courts, AG opinions and constitutional changes as the second layer.

[1]: https://www.legis.ga.gov/legislation/72733?ceid=%7B%7BContactsEmailID%7D%7D&emci=27a344cd-0d10-f111-a69a-000d3a57593f&emdi=ea000000-0000-0000-0000-000000000001&utm_source=chatgpt.com "HB 1161 - Georgia General Assembly"
[2]: https://www.legis.ga.gov/api/document/docs/default-source/legislative-counsel-document-library/sumdoc2026-edit.pdf?utm_source=chatgpt.com "FOREWORD

We are pleased to present to you the Sum"
[3]: https://www.legis.ga.gov/?utm_source=chatgpt.com "Georgia General Assembly"
[4]: https://gov.georgia.gov/executive-action/legislation?utm_source=chatgpt.com "Legislation | Governor Brian P. Kemp Office of the Governor"
[5]: https://gov.georgia.gov/executive-action/legislation/signed-legislation/2026?utm_source=chatgpt.com "2026 | Governor Brian P. Kemp Office of the Governor"
[6]: https://gov.georgia.gov/executive-action/executive-orders/2026?utm_source=chatgpt.com "2026 | Governor Brian P. Kemp Office of the Governor"
[7]: https://rules.sos.ga.gov/?utm_source=chatgpt.com "GA R&R - Home"
[8]: https://rules.sos.ga.gov/Download_pdf.aspx?utm_source=chatgpt.com "GA R&R - PDF Download"
[9]: https://www.agr.georgia.gov/sites/default/files/documents/assets/georgias-rulemaking-process.pdf?utm_source=chatgpt.com "GEORGIA’S AGENCY RULEMAKING PROCESS"
[10]: https://epd.georgia.gov/public-announcements-0/proposed-rules?utm_source=chatgpt.com "Proposed Rules | Environmental Protection Division"
[11]: https://dor.georgia.gov/lgsd-2026-002-proposed-regulations-560-11-16-04-560-11-16-05-and-appendix-560-11-16?utm_source=chatgpt.com "LGSD 2026-002 - Proposed Regulations 560-11-16-.04, 560-11-16-.05 and Appendix 560-11-16-A | Department of Revenue"
[12]: https://oci.georgia.gov/press-releases/2026-06-29/hearing-july-29-2026?utm_source=chatgpt.com "Hearing July 29 2026 | Office of the Commissioner of Insurance and Safety Fire"
[13]: https://sos.ga.gov/page/proposed-state-election-board-rules-and-rule-amendments?utm_source=chatgpt.com "Proposed State Election Board Rules and Rule Amendments | Georgia Secretary of State"
[14]: https://georgia.gov/state-organizations?utm_source=chatgpt.com "State Organizations"
[15]: https://www.gasupreme.us/2026-opinions/?utm_source=chatgpt.com "2026 Opinions – Supreme Court of Georgia"
[16]: https://www.gasupreme.us/forthcoming-opinions/?utm_source=chatgpt.com "Forthcoming Opinions – Supreme Court of Georgia"
[17]: https://www.gasupreme.us/reporter-of-decisions/?utm_source=chatgpt.com "Reporter of Decisions of the Supreme Court of Georgia and the Court of Appeals of Georgia – Supreme Court of Georgia"
[18]: https://law.georgia.gov/opinions?utm_source=chatgpt.com "Opinions"
[19]: https://law.georgia.gov/about-us/duties?utm_source=chatgpt.com "Duties | Office of the Attorney General"
[20]: https://sos.ga.gov/page/proposed-georgia-constitution-amendments?utm_source=chatgpt.com "Proposed Georgia Constitution Amendments | Georgia Secretary of State"
[21]: https://docs.openstates.org/api-v3/?utm_source=chatgpt.com "API v3 Overview - Open States"
