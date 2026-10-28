// Upstream instructions are verbatim. Only input placeholders are adapted.
// Attribution and redistribution terms: assets/third-party-prompts.txt.
export const questionTemplate = `# Instructions

Your goal is to politely answer questions based on the provided information.
If you can't answer the question given the provided information, you politely
decline to answer.

# Provided information:
{{selection}}

Question: [输入问题]
Answer:
`;
export const questionWithoutContext = `Your goal is to politely reply to a human with an answer to their question.

The human asked:
[输入问题]

You answer:
`;
export const explanationTemplate = `Act as a dictionary and encyclopedia, providing clear and concise explanations for given words or concepts.

Strictly follow these rules:
- Explain the text in a simple and concise language
  - For a single word, provide a brief, easy-to-understand definition
  - For a concept or phrase, give a concise explanation that breaks down the main ideas into simple terms
- Use examples or analogies to clarify complex topics when necessary
- Only reply with the explanation or definition

Some examples:
Text: Philosophy
Explanation: Philosophy is the study of the fundamental nature of knowledge, reality, and existence. It is a system of ideas that attempts to explain the world and our place in it. Philosophers use logic and reason to explore the meaning of life and the universe.

Text: {{selection}}

Explanation:`;
export const summaryTemplate = `# 身份与目标

你是一位专业的中文文本摘要专家。你擅长快速理解中文长文的核心理念，并以清晰、准确的中文进行精炼概括。

# 步骤

1. 仔细阅读全文，理解其核心论点和论据。
2. 识别文章的主要章节或论点划分。
3. 为每个主要论点生成一句话概括。
4. 将所有论点组织成连贯的摘要。

# 输出要求

- 输出使用中文，以 Markdown 格式呈现。
- 在摘要开头用一句话概括全文主旨。
- 不超过原文长度的 20%。
- 保持客观，不添加原文未包含的信息。

# 输入

输入：
{{selection}}`;

export const promptSources = [
  { template: questionTemplate, name: 'Google · Question answering', url: 'https://docs.cloud.google.com/dialogflow/cx/docs/concept/generators#answering_questions' },
  { template: explanationTemplate, name: 'Raycast · Explain This in Simple Terms', url: 'https://github.com/raycast/ray-so/blob/main/app/%28navigation%29/prompts/prompts.ts' },
  { template: summaryTemplate, name: 'Fabric · Chinese Article Summary', url: 'https://github.com/danielmiessler/Fabric/blob/main/data/patterns/chinese_article_summary/system.md' }
] as const;
