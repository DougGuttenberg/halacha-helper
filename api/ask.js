// HalachaHelper - Consolidated API endpoint
// Combines triage, search, and reasoning into one serverless function

const SEFARIA_API = 'https://www.sefaria.org/api';

// ===========================================
// SOURCE HIERARCHY
// ===========================================
const SOURCE_PRIORITY = {
  'Shulchan Arukh HaRav': 1,
  'Shulchan Arukh': 2,
  'Mishneh Torah': 3,
  'Talmud': 4,
  'Torah': 5,
  'Mishnah Berurah': 6,
  'Aruch HaShulchan': 7,
  'Other': 10
};

function getSourceCategory(ref) {
  if (ref.includes('Shulchan Arukh HaRav') || ref.includes("Shulchan Aruch HaRav")) {
    return 'Shulchan Arukh HaRav';
  }
  if (ref.includes('Shulchan Arukh') || ref.includes('Shulchan Aruch')) {
    return 'Shulchan Arukh';
  }
  if (ref.includes('Mishneh Torah') || ref.includes('Rambam')) {
    return 'Mishneh Torah';
  }
  if (ref.includes('Talmud') || ref.includes('Bavli') || ref.includes('Yerushalmi') ||
      ref.match(/^(Berakhot|Shabbat|Eruvin|Pesachim|Yoma|Sukkah|Beitzah|Rosh Hashanah|Taanit|Megillah|Moed Katan|Chagigah|Yevamot|Ketubot|Nedarim|Nazir|Sotah|Gittin|Kiddushin|Bava Kamma|Bava Metzia|Bava Batra|Sanhedrin|Makkot|Shevuot|Avodah Zarah|Horayot|Zevachim|Menachot|Chullin|Bekhorot|Arakhin|Temurah|Keritot|Meilah|Tamid|Middot|Kinnim|Niddah)/i)) {
    return 'Talmud';
  }
  if (ref.match(/^(Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Bereishit|Shemot|Vayikra|Bamidbar|Devarim)/i)) {
    return 'Torah';
  }
  if (ref.includes('Mishnah Berurah')) {
    return 'Mishnah Berurah';
  }
  if (ref.includes('Aruch HaShulchan')) {
    return 'Aruch HaShulchan';
  }
  return 'Other';
}

function sortByHierarchy(sources) {
  return sources.sort((a, b) => {
    const priorityA = SOURCE_PRIORITY[a.category] || 10;
    const priorityB = SOURCE_PRIORITY[b.category] || 10;
    return priorityA - priorityB;
  });
}

// ===========================================
// SEFARIA API FUNCTIONS
// ===========================================
async function searchSefaria(query, filters = []) {
  try {
    const response = await fetch(`${SEFARIA_API}/search-wrapper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        type: 'text',
        field: 'naive_lemmatizer',
        slop: 10,
        size: 15,
        filters: filters.length > 0 ? filters : ['Halakhah', 'Talmud', 'Tanakh'],
        filter_fields: ['path'],
        source_proj: true
      })
    });

    if (!response.ok) return [];

    const data = await response.json();
    if (!data.hits || !data.hits.hits) return [];

    return data.hits.hits.map(hit => ({
      ref: hit._source?.ref || hit._id,
      snippet: hit._source?.exact || hit._source?.naive_lemmatizer || '',
      score: hit._score,
      path: hit._source?.path || ''
    }));
  } catch (error) {
    console.error('Sefaria search error:', error);
    return [];
  }
}

async function fetchText(ref) {
  try {
    const url = `${SEFARIA_API}/texts/${encodeURIComponent(ref)}?context=0&pad=0`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    let english = '';
    let hebrew = '';

    if (data.text) {
      english = Array.isArray(data.text)
        ? data.text.flat(3).filter(t => t).join(' ')
        : data.text;
    }
    if (data.he) {
      hebrew = Array.isArray(data.he)
        ? data.he.flat(3).filter(t => t).join(' ')
        : data.he;
    }

    english = english.replace(/<[^>]*>/g, '').trim().substring(0, 1500);
    hebrew = hebrew.replace(/<[^>]*>/g, '').trim().substring(0, 1500);

    return {
      ref: ref,
      english,
      hebrew,
      heTitle: data.heRef || ref,
      category: getSourceCategory(ref)
    };
  } catch (error) {
    console.error('Failed to fetch text:', ref, error);
    return null;
  }
}

async function searchSources(searchTerms, sefariaRefs) {
  const allSources = new Map();

  try {
    // 1. Fetch directly specified references
    if (sefariaRefs && sefariaRefs.length > 0) {
      const directFetches = sefariaRefs.map(ref => fetchText(ref));
      const directResults = await Promise.all(directFetches);
      for (const result of directResults) {
        if (result) allSources.set(result.ref, result);
      }
    }

    // 2. Search using Hebrew terms
    if (searchTerms?.hebrew && searchTerms.hebrew.length > 0) {
      for (const term of searchTerms.hebrew.slice(0, 3)) {
        const results = await searchSefaria(term, ['Halakhah']);
        for (const result of results.slice(0, 5)) {
          if (!allSources.has(result.ref)) {
            const fullText = await fetchText(result.ref);
            if (fullText) allSources.set(result.ref, fullText);
          }
        }
      }
    }

    // 3. Search using English terms as fallback
    if (searchTerms?.english && searchTerms.english.length > 0 && allSources.size < 5) {
      for (const term of searchTerms.english.slice(0, 2)) {
        const results = await searchSefaria(term, ['Halakhah', 'Talmud']);
        for (const result of results.slice(0, 3)) {
          if (!allSources.has(result.ref)) {
            const fullText = await fetchText(result.ref);
            if (fullText) allSources.set(result.ref, fullText);
          }
        }
      }
    }

    const sourcesArray = sortByHierarchy(Array.from(allSources.values()));

    return {
      success: sourcesArray.length > 0,
      totalSources: sourcesArray.length,
      allSourcesList: sourcesArray,
      searchInfo: {
        hebrewTermsUsed: searchTerms?.hebrew || [],
        englishTermsUsed: searchTerms?.english || [],
        directRefsChecked: sefariaRefs || []
      }
    };
  } catch (error) {
    console.error('Search sources error:', error);
    return { success: false, totalSources: 0, allSourcesList: [], searchInfo: {} };
  }
}

// ===========================================
// CLAUDE API CALLS
// ===========================================
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Anthropic API error:', error);
    throw new Error('AI service error');
  }

  const data = await response.json();
  const content = data.content[0].text;

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  throw new Error('Failed to parse AI response');
}

// ===========================================
// TRIAGE
// ===========================================
const TRIAGE_PROMPT = `You are a halachic question analyst. Your job is to analyze incoming questions about Jewish law and prepare them for proper halachic research.

## Your Task
Analyze the question and return a structured assessment. Do NOT answer the question - only analyze it.

## Classification Categories

### Question Type
- **din**: A question about binding halachic law (e.g., "Is X permitted?")
- **minhag**: A question about custom (e.g., "What's the custom for X?")
- **hashkafa**: A philosophical/theological question (e.g., "Why does Judaism say X?")
- **practical**: A how-to question (e.g., "How do I do X?")

### Halachic Level
- **d_oraita**: Biblical law (Torah-level obligation)
- **d_rabbanan**: Rabbinic law (enacted by the Sages)
- **minhag**: Custom (binding but not law)
- **uncertain**: Cannot determine without more information

## Context Assessment

Determine if the question requires situational context to answer properly. Many halachic questions depend on circumstances.

Examples requiring context:
- "Can I do X?" often depends on: When? Where? What's the situation?
- Questions about waiting times depend on: Which tradition does the person follow?
- Questions about leniencies depend on: Is there financial loss? Health concerns?

Examples NOT requiring context:
- "What is the law about X?" (asking for general rule)
- "What bracha do I make on X?" (usually straightforward)
- "What does X mean?" (definitional)

## Search Term Generation

Generate search terms for Sefaria. Include:
1. Hebrew terms (use Hebrew script)
2. English transliterations
3. Related halachic concepts

## Must Defer to Rabbi

Some questions MUST be deferred:
- Medical situations affecting practice
- Personal/emotional circumstances
- Interpersonal conflicts
- Specific kashrut certifications
- End-of-life or beginning-of-life questions

## Response Format

Return ONLY valid JSON:
{
  "questionType": "din|minhag|hashkafa|practical",
  "level": "d_oraita|d_rabbanan|minhag|uncertain",
  "domain": {
    "name": "Primary halachic domain",
    "hebrewName": "Hebrew name",
    "sugya": "Specific topic",
    "shulchanAruchSection": "OC/YD/EH/CM if known"
  },
  "needsContext": true|false,
  "contextQuestions": [
    {
      "question": "The follow-up question",
      "why": "Why this matters",
      "options": ["Option 1", "Option 2"]
    }
  ],
  "isAmbiguous": true|false,
  "clarifications": ["What needs clarifying"],
  "mustDeferToRabbi": true|false,
  "deferReason": "Why defer (or null)",
  "searchTerms": {
    "hebrew": ["Hebrew terms"],
    "english": ["English terms"],
    "sefariaRefs": ["Specific refs like 'Shulchan Arukh, Yoreh Deah 89'"]
  },
  "initialAssessment": "1-2 sentence summary of the question"
}`;

async function triageQuestion(question) {
  return callClaude(TRIAGE_PROMPT, `Analyze this halachic question:\n\n"${question}"`);
}

// ===========================================
// REASONING
// ===========================================
const REASONING_PROMPT = `You are a halachic reasoning engine. You have been given a question, contextual information, and ACTUAL SOURCE TEXTS from Sefaria. Your job is to analyze these sources and provide a halachic ruling following proper methodology.

## CRITICAL RULES

1. **ONLY cite sources that were provided to you.** Do not reference sources from your training data.
2. **If the provided sources don't clearly answer the question, say so.**
3. **Distinguish between what the sources say and your interpretation.**

## Source Hierarchy (Chabad-Oriented)

1. **Shulchan Arukh HaRav** (Alter Rebbe) - Primary for practical ruling
2. **Shulchan Arukh** (Mechaber for Sephardim, Rema for Ashkenazim)
3. **Mishneh Torah** (Rambam)
4. **Talmud Bavli**
5. **Torah/Chumash**
6. **Acharonim** (Mishnah Berurah, etc.)

## Halachic Decision Principles

### Certainty vs. Doubt
- **Safek d'oraita l'chumra**: Biblical doubt → rule strictly
- **Safek d'rabbanan l'kula**: Rabbinic doubt → may be lenient
- **Sfek sfeka**: Double doubt → leniency permitted

### Dispute Resolution
- Follow Shulchan Arukh unless Shulchan Arukh HaRav rules differently
- Majority opinion (rov) generally prevails
- Established custom (minhag) can override minority opinions

### Circumstantial Factors
- **Hefsed merubah**: Financial loss may permit leniencies
- **Sha'at hadchak**: Pressing circumstances
- **Choleh**: Illness may permit rabbinic leniencies

## Response Format

Return ONLY valid JSON:
{
  "canAnswer": true|false,
  "answer": "The direct answer with its basis",
  "ruling": {
    "summary": "One-sentence practical ruling",
    "basis": "Primary source",
    "level": "d_oraita|d_rabbanan|minhag",
    "certainty": "definitive|majority_opinion|lenient_opinion|uncertain"
  },
  "reasoning": [
    {
      "level": "Shulchan Arukh HaRav|Shulchan Arukh|Rambam|Talmud|Torah|Acharonim",
      "source": "Exact source reference",
      "text": "What this source says",
      "analysis": "How this applies"
    }
  ],
  "disputes": [
    {
      "issue": "What is disputed",
      "opinions": ["Opinion 1", "Opinion 2"],
      "resolution": "How we resolve this"
    }
  ],
  "sources": ["Array of sources cited"],
  "confidence": 0-100,
  "confidenceExplanation": "Why this confidence level",
  "chabadNote": "Chabad-specific practice or null",
  "domain": { "name": "Domain", "translation": "Translation" },
  "jargon": [{ "term": "Term", "translation": "Meaning", "explanation": "Context" }],
  "limitations": "Caveats on this ruling",
  "consultRabbi": "When to still consult a rabbi"
}`;

async function reasonWithSources(question, context, triage, sources) {
  const sourcesSummary = sources.allSourcesList.map(s => {
    return `### ${s.ref} [${s.category}]
Hebrew: ${s.hebrew ? s.hebrew.substring(0, 500) : 'N/A'}
English: ${s.english ? s.english.substring(0, 500) : 'N/A'}`;
  }).join('\n\n');

  const contextSummary = context && context.length > 0
    ? `User provided context:\n${context.map(c => `- ${c.question}: ${c.answer}`).join('\n')}`
    : 'No additional context provided.';

  const triageSummary = triage
    ? `Question Analysis:
- Type: ${triage.questionType}
- Level: ${triage.level}
- Domain: ${triage.domain?.name || 'Unknown'}
- Initial Assessment: ${triage.initialAssessment || 'N/A'}`
    : 'No triage data.';

  const userMessage = `## Question
"${question}"

## ${triageSummary}

## ${contextSummary}

## Sources from Sefaria (${sources.totalSources} found)

${sourcesSummary}

---

Analyze these sources and provide a halachic ruling. ONLY cite sources that appear above.`;

  const result = await callClaude(REASONING_PROMPT, userMessage, 3000);

  // Add source texts for frontend display
  result.sourceTexts = {};
  for (const source of sources.allSourcesList) {
    result.sourceTexts[source.ref] = {
      ref: source.ref,
      english: source.english,
      hebrew: source.hebrew,
      found: true
    };
  }

  return result;
}

// ===========================================
// MAIN HANDLER
// ===========================================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, context, sessionState } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  try {
    // If we have complete session state, go to search + reason
    if (sessionState?.triageComplete && sessionState?.contextComplete) {
      const sources = await searchSources(
        sessionState.triage.searchTerms,
        sessionState.triage.searchTerms?.sefariaRefs || []
      );

      if (!sources.success || sources.totalSources === 0) {
        return res.status(200).json({
          phase: 'complete',
          canAnswer: false,
          noSourcesFound: true,
          answer: "I couldn't find relevant halachic sources for this question. Please consult a rabbi.",
          triage: sessionState.triage,
          sourcesSearched: sources.searchInfo
        });
      }

      const result = await reasonWithSources(question, context || [], sessionState.triage, sources);

      return res.status(200).json({
        phase: 'complete',
        ...result,
        triage: sessionState.triage,
        sourcesFound: sources.totalSources
      });
    }

    // If triage complete but context needed
    if (sessionState?.triageComplete && !sessionState?.contextComplete) {
      const sources = await searchSources(
        sessionState.triage.searchTerms,
        sessionState.triage.searchTerms?.sefariaRefs || []
      );

      if (!sources.success || sources.totalSources === 0) {
        return res.status(200).json({
          phase: 'complete',
          canAnswer: false,
          noSourcesFound: true,
          answer: "I couldn't find relevant halachic sources for this question. Please consult a rabbi.",
          triage: sessionState.triage,
          sourcesSearched: sources.searchInfo
        });
      }

      const result = await reasonWithSources(question, context || [], sessionState.triage, sources);

      return res.status(200).json({
        phase: 'complete',
        ...result,
        triage: sessionState.triage,
        sourcesFound: sources.totalSources
      });
    }

    // Fresh question - start with triage
    const triage = await triageQuestion(question);

    // Check if must defer immediately
    if (triage.mustDeferToRabbi) {
      return res.status(200).json({
        phase: 'complete',
        canAnswer: false,
        mustDeferToRabbi: true,
        answer: triage.deferReason || "This question requires personal rabbinic guidance.",
        triage: triage,
        domain: triage.domain
      });
    }

    // Check if needs context
    if (triage.needsContext && triage.contextQuestions && triage.contextQuestions.length > 0) {
      return res.status(200).json({
        phase: 'needs_context',
        triage: triage,
        contextQuestions: triage.contextQuestions,
        sessionState: {
          triageComplete: true,
          contextComplete: false,
          triage: triage
        }
      });
    }

    // Check for ambiguity
    if (triage.isAmbiguous && triage.clarifications && triage.clarifications.length > 0) {
      return res.status(200).json({
        phase: 'needs_clarification',
        triage: triage,
        clarifications: triage.clarifications,
        sessionState: {
          triageComplete: true,
          contextComplete: false,
          triage: triage
        }
      });
    }

    // No context needed - proceed directly
    const sources = await searchSources(
      triage.searchTerms,
      triage.searchTerms?.sefariaRefs || []
    );

    if (!sources.success || sources.totalSources === 0) {
      return res.status(200).json({
        phase: 'complete',
        canAnswer: false,
        noSourcesFound: true,
        answer: "I couldn't find relevant halachic sources for this question. Please consult a rabbi.",
        triage: triage,
        sourcesSearched: sources.searchInfo
      });
    }

    const result = await reasonWithSources(question, [], triage, sources);

    return res.status(200).json({
      phase: 'complete',
      ...result,
      triage: triage,
      sourcesFound: sources.totalSources
    });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: 'Failed to process question: ' + error.message });
  }
}
