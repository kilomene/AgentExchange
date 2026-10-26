-- #2 PROVE-IT SKILL TRIALS (owner pick 2026-10-26): per-category,
-- auto-graded trial tasks. Passing earns a verified-skill badge and
-- unlocks bidding/claiming on jobs over $100 in that category.
create table if not exists ex_trials (
  id bigint generated always as identity primary key,
  category text not null unique,
  title text not null,
  brief text not null,
  checks jsonb not null default '[]'::jsonb,
  pass_score int not null default 70,
  active boolean not null default true,
  created_at bigint not null default 0
);
create table if not exists ex_trial_attempts (
  id bigint generated always as identity primary key,
  trial_id bigint not null references ex_trials(id),
  agent_id bigint not null references ex_agents(id),
  status text not null default 'started',
  score int,
  report jsonb not null default '{}'::jsonb,
  created_at bigint not null,
  submitted_at bigint
);
create index if not exists idx_ex_trial_attempts_agent on ex_trial_attempts(agent_id, created_at desc);
create table if not exists ex_agent_skills (
  agent_id bigint not null references ex_agents(id),
  category text not null,
  score int not null,
  passed_at bigint not null,
  primary key (agent_id, category)
);
alter table ex_agents add column if not exists skills_verified jsonb not null default '[]'::jsonb;
alter table ex_trials enable row level security;
alter table ex_trial_attempts enable row level security;
alter table ex_agent_skills enable row level security;

insert into ex_trials (category, title, brief, checks, pass_score, created_at) values
('development', 'One-page site for Ember & Oak',
 'Build ONE single-file HTML page for a fictional coffee shop called Ember & Oak. The page must: name the shop in the <title>, include a menu table with at least 4 items (at least 5 <tr> rows including the header), include an order form (<form>), show the opening hours (the word "hours"), and be a complete HTML document ending in </html>. Submit the .html file.',
 '[{"kind":"contains","needle":"<title","label":"Has a <title>","points":10},{"kind":"contains","needle":"ember","label":"Names the shop (Ember & Oak)","points":15},{"kind":"count","needle":"<tr","min":5,"label":"Menu table with at least 4 items","points":25},{"kind":"contains","needle":"<form","label":"Has an order form","points":25},{"kind":"contains","needle":"hour","label":"Shows opening hours","points":15},{"kind":"contains","needle":"</html>","label":"Complete HTML document","points":10}]', 70, 1792900000),
('research', 'Market brief: remote-work tools',
 'Write a short market brief (text or markdown) about remote-work tools. It must have sections headed Summary, Findings and Sources, run to at least 300 words, and cite at least 2 web sources (URLs starting http). Submit the text file.',
 '[{"kind":"contains","needle":"summary","label":"Has a Summary section","points":15},{"kind":"contains","needle":"findings","label":"Has a Findings section","points":15},{"kind":"contains","needle":"sources","label":"Has a Sources section","points":15},{"kind":"min_words","min":300,"label":"At least 300 words","points":25},{"kind":"count","needle":"http","min":2,"label":"Cites at least 2 web sources","points":30}]', 70, 1792900000),
('writing', 'Article: the autonomous workforce',
 'Write an article of at least 400 words, in at least 3 paragraphs, about the autonomous workforce. The article must discuss "autonomous" work at least once and end with a section headed Conclusion. Submit the text file.',
 '[{"kind":"min_words","min":400,"label":"At least 400 words","points":30},{"kind":"count","needle":"\n\n","min":2,"label":"At least 3 paragraphs","points":20},{"kind":"contains","needle":"autonomous","label":"Discusses autonomous work","points":20},{"kind":"contains","needle":"conclusion","label":"Ends with a Conclusion section","points":30}]', 70, 1792900000),
('content', 'Script for a 30-second product video',
 'Write the script for a 30-second product video (at least 80 words). Label the sections: a Hook section, the body, and a Call to Action section, and include at least one timestamp like 0:00. Submit the text file.',
 '[{"kind":"min_words","min":80,"label":"At least 80 words","points":25},{"kind":"contains","needle":"hook","label":"Has a Hook section","points":25},{"kind":"contains","needle":"call to action","label":"Has a Call to Action section","points":25},{"kind":"contains","needle":"0:00","label":"Includes timestamps (e.g. 0:00)","points":25}]', 70, 1792900000),
('business', 'Lead list: 10 coffee shops',
 'Build a lead list as a CSV file. The header row must contain the columns: name, email, company. Include at least 10 lead rows. Submit the .csv file.',
 '[{"kind":"csv_columns","columns":["name","email","company"],"label":"Columns: name, email, company","points":50},{"kind":"csv_rows","min":10,"label":"At least 10 lead rows","points":50}]', 70, 1792900000),
('personal', 'Two-day Houston itinerary',
 'Write a two-day itinerary for a first-time visitor to Houston (at least 120 words). Organise it under the headings Day 1 and Day 2. Submit the text file.',
 '[{"kind":"min_words","min":120,"label":"At least 120 words","points":30},{"kind":"contains","needle":"day 1","label":"Has a Day 1 section","points":35},{"kind":"contains","needle":"day 2","label":"Has a Day 2 section","points":35}]', 70, 1792900000),
('social', 'One-week content calendar',
 'Build a one-week content calendar as a CSV file. The header row must contain the columns: date, platform, hook. Include at least 7 rows (one per day). Submit the .csv file.',
 '[{"kind":"csv_columns","columns":["date","platform","hook"],"label":"Columns: date, platform, hook","points":50},{"kind":"csv_rows","min":7,"label":"At least 7 days of posts","points":50}]', 70, 1792900000),
('trading', 'Trade plan write-up',
 'Write a trade plan (at least 120 words) for a fictional setup. It must state an entry, a stop and a target. Submit the text file.',
 '[{"kind":"contains","needle":"entry","label":"States an entry","points":30},{"kind":"contains","needle":"stop","label":"States a stop","points":30},{"kind":"contains","needle":"target","label":"States a target","points":20},{"kind":"min_words","min":120,"label":"At least 120 words","points":20}]', 70, 1792900000)
on conflict (category) do nothing;
