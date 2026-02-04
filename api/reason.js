export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, context, triage, sources } = req.body;

  if (!question || !sources) {
    return res.status(400).json({ error: 'Question and sources are required' });
  }

  // Check if we have enough sources to answer
  if (!sources.allSourcesList || sources.allSourcesList.length === 0) {
    return res.status(200).json({
      canAnswer: false,
      noSourcesFound: true,
      answer: "I was unable to find relevant halachic sources for this question in the texts I searched. This question should be directed to a rabbi who can research the primary sources.",
      reasoning: [],
      sources: [],
      confidence: 0,
      domain: triage?.domain || null
    });
  }

  const REASONING_PROMPT = `You are a halachic reasoning engine. You have been given a question, contextual information, and ACTUAL SOURCE TEXTS from Sefaria. Your job is to analyze these sources and provide a halachic ruling following proper methodology.

## CRITICAL RULES

1. **ONLY cite sources that were provided to you.** Do not reference sources from your training data that are not in the provided materials.
2. **If the provided sources don't clearly answer the question, say so.** Don't fabricate rulings.
3. **Distinguish between what the sources say and your interpretation.**

## Source Hierarchy (Chabad-Oriented)

When sources conflict or multiple opinions exist, follow this hierarchy:

1. **Shulchan Arukh HaRav** (Alter Rebbe) - Primary for practical ruling when available
2. **Shulchan Arukh** (Mechaber for Sephardim, Rema for Ashkenazim) - Foundational code
3. **Mishneh Torah** (Rambam) - For systematic understanding and when later codes are silent
4. **Talmud Bavli** - Primary rabbinic source; Yerushalmi when Bavli is silent
5. **Torah/Chumash** - Biblical basis
6. **Acharonim** (Mishnah Berurah, Aruch HaShulchan) - When earlier sources are unclear
7. **Contemporary poskim** - For modern applications

## Halachic Decision Principles

Apply these principles when analyzing the sources:

### Certainty vs. Doubt
- **Safek d'oraita l'chumra**: Biblical doubt → rule strictly
- **Safek d'rabbanan l'kula**: Rabbinic doubt → may be lenient
- **Sfek sfeka**: Double doubt → leniency permitted even in biblical matters

### Dispute Resolution
- When poskim disagree, follow Shulchan Arukh unless Shulchan Arukh HaRav rules differently
- Majority opinion (rov) generally prevails
- Established custom (minhag) can override minority opinions
- In pressing circumstances (sha'at hadchak), may rely on minority lenient opinion

### Circumstantial Factors
Consider if any of these apply (based on context provided):
- **Hefsed merubah**: Significant financial loss may permit leniencies in rabbinic matters
- **Sha'at hadchak**: Pressing circumstances may allow reliance on lenient opinions
- **Choleh**: Illness (even non-dangerous) may permit rabbinic leniencies
- **Kavod habriyot**: Human dignity may override certain rabbinic prohibitions
- **Tza'ar**: Significant discomfort may be a factor in rabbinic matters

### Din vs. Minhag
- Clearly distinguish between binding law (din) and custom (minhag)
- Minhag is binding for one's community but may differ between communities
- Custom cannot override explicit law but may affect practice in gray areas

## What You Must Do

1. **Identify the core halachic issue** from the question
2. **Trace through the sources** in hierarchical order
3. **Note any disputes** and how they are resolved
4. **Apply circumstantial factors** if context was provided
5. **State the ruling clearly** with its basis
6. **Specify confidence level** based on source clarity

## When to Defer to a Rabbi

Even with clear sources, defer if:
- The question involves medical considerations
- Personal circumstances significantly complicate the matter
- There's genuine dispute among major poskim with no clear resolution
- The question involves interpersonal issues requiring judgment
- Modern technology creates novel situations not clearly addressed

## Response Format

Return ONLY valid JSON:
{
  "canAnswer": true|false,
  "answer": "The clear, practical ruling with its basis",
  "ruling": {
    "summary": "One-sentence summary of the practical ruling",
    "basis": "The primary source this ruling is based on",
    "level": "d_oraita|d_rabbanan|minhag",
    "certainty": "definitive|majority_opinion|lenient_opinion|uncertain"
  },
  "reasoning": [
    {
      "level": "Shulchan Arukh HaRav|Shulchan Arukh|Rambam|Talmud|Torah|Acharonim",
      "source": "Exact source reference",
      "text": "What this source says (quote or close paraphrase)",
      "analysis": "How this applies to the question"
    }
  ],
  "disputes": [
    {
      "issue": "What is disputed",
      "opinions": ["Opinion 1", "Opinion 2"],
      "resolution": "How we resolve this dispute and why"
    }
  ],
  "circumstanceFactors": {
    "considered": ["List factors that were considered"],
    "applied": "How they affected the ruling (or 'N/A')"
  },
  "sources": ["Array of all sources cited"],
  "confidence": 0-100,
  "confidenceExplanation": "Why this confidence level",
  "chabadNote": "Chabad-specific practice if different from general ruling, or null",
  "domain": {
    "name": "Halachic domain",
    "translation": "English translation"
  },
  "jargon": [
    {
      "term": "Hebrew/Aramaic term",
      "translation": "English meaning",
      "explanation": "Brief explanation if needed"
    }
  ],
  "limitations": "Any limitations or caveats on this ruling",
  "consultRabbi": "Specific situations where one should still consult a rabbi, even with this ruling"
}`;

  // Build the context message with actual sources
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

Now analyze these sources and provide a halachic ruling following the methodology described. Remember: ONLY cite sources that appear above. If the sources don't clearly address the question, say so.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: REASONING_PROMPT,
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Anthropic API error:', error);
      return res.status(500).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const content = data.content[0].text;

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Add the source texts for frontend display
      parsed.sourceTexts = {};
      for (const source of sources.allSourcesList) {
        parsed.sourceTexts[source.ref] = {
          ref: source.ref,
          english: source.english,
          hebrew: source.hebrew,
          found: true
        };
      }
      return res.status(200).json(parsed);
    }

    return res.status(500).json({ error: 'Failed to parse reasoning response' });

  } catch (error) {
    console.error('Reasoning error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
