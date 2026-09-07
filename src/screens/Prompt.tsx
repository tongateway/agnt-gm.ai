// Prompt — the Home hero: "Describe the bot you want" (Bold 1c).
// Top row: AGNTDEV brand lockup left, language toggle right. Eyebrow pill,
// two-tone hero, prompt card with a terracotta "Build it" button, idea chips.
import { useEffect, useRef } from 'react';
import { Theme, btnReset } from '../theme';
import { TGIcon, Spinner, Wordmark } from '../ui';
import { useLang, useT, tr } from '../i18n';

// Each example is a short button (title + blurb) that drops a rich, detailed
// brief into the prompt box. That brief is what gets sent verbatim as the
// first message to the builder AI — a fuller brief means a more
// production-ready bot and fewer clarifying questions.
export type IdeaExample = { title: [string, string]; blurb: [string, string]; prompt: [string, string] };

export const IDEA_EXAMPLES: IdeaExample[] = [
  {
    title: ['Crypto price alerts', 'Оповещения о ценах на крипту'],
    blurb: [
      'Watchlist · threshold & %-move alerts · price check · quiet hours',
      'Список отслеживания · пороговые и %-оповещения · проверка цены · тихие часы',
    ],
    prompt: [
      'I want a Telegram bot that watches crypto prices and pings me when something moves. Each person keeps their own private watchlist and adds or removes coins with inline buttons — Bitcoin, Ethereum, Toncoin, or any ticker they type. Support two kinds of alerts: a price threshold ("tell me when BTC drops below $60k") and a percentage move ("tell me when any coin on my list jumps or falls more than 5% in an hour"). Add a /price command for an on-demand check of one coin or my whole list, and an optional morning summary at a time I choose. Include quiet hours so it never alerts me overnight, and don\'t spam — if a coin keeps wobbling around my threshold, send one alert and then cool down for a while instead of firing repeatedly. Every alert should say exactly which coin moved, the old and new price, and the percent change. If a price feed fails, retry quietly instead of sending bad numbers, and handle unknown tickers or typos with a helpful reply. Keep each person\'s watchlist and settings private, and give me an owner view of how many people use it and which alerts fire most.',
      'Хочу телеграм-бота, который следит за ценами на крипту и пингует меня, когда что-то движется. У каждого свой приватный список отслеживания: монеты добавляются и удаляются инлайн-кнопками — Bitcoin, Ethereum, Toncoin или любой тикер, который введут. Нужны два вида оповещений: пороговое по цене («сообщи, когда BTC упадёт ниже $60k») и по проценту изменения («сообщи, когда любая монета из моего списка вырастет или упадёт больше чем на 5% за час»). Добавь команду /price для проверки по запросу одной монеты или всего списка, и опциональную утреннюю сводку во время, которое я выберу. Сделай тихие часы, чтобы бот не будил меня ночью, и не спамь — если монета всё время колеблется вокруг порога, отправь одно оповещение, а потом сделай паузу вместо того, чтобы срабатывать снова и снова. В каждом оповещении должно быть чётко указано, какая монета сдвинулась, старая и новая цена и процент изменения. Если источник цен даёт сбой, тихо повтори попытку, а не отправляй неверные числа, и обрабатывай неизвестные тикеры и опечатки понятным ответом. Держи список отслеживания и настройки каждого пользователя приватными, а мне как владельцу покажи, сколько людей пользуется ботом и какие оповещения срабатывают чаще всего.',
    ],
  },
  {
    title: ['Restaurant table booking', 'Бронирование столиков в ресторане'],
    blurb: [
      'Live availability · instant confirm · reminders · reschedule',
      'Актуальная доступность · мгновенное подтверждение · напоминания · перенос',
    ],
    prompt: [
      'I want a Telegram bot that takes table reservations for my restaurant. A guest taps to start, then picks a date, a time, and party size, and the bot only ever offers slots that are genuinely open — it checks real availability against my tables and capacity and never shows a time that\'s already full. As soon as they choose, confirm the booking with a clear message and a short reference code, then send a reminder a couple of hours before. Guests can reschedule or cancel from inline buttons without messaging us. Let me configure the basics — opening hours, how long a sitting lasts, and how many tables and seats I have — so the bot prevents double-booking and overbooking on its own. On my side I need an owner view of all upcoming bookings, today\'s remaining capacity at a glance, and a flag on no-shows. Handle odd or partial input gracefully, keep guest details private, and stay friendly and clear at every step. No payments needed.',
      'Хочу телеграм-бота, который принимает брони столиков в моём ресторане. Гость нажимает «начать», затем выбирает дату, время и число человек, а бот предлагает только реально свободные слоты — он сверяет настоящую доступность с моими столиками и вместимостью и никогда не показывает уже занятое время. Как только гость выбрал, подтверди бронь понятным сообщением и коротким кодом брони, а за пару часов до визита пришли напоминание. Гости могут перенести или отменить бронь инлайн-кнопками, не переписываясь с нами. Дай мне настроить основное — часы работы, длительность посадки и сколько у меня столиков и мест — чтобы бот сам не допускал двойных броней и переполнения. Со своей стороны мне нужен вид владельца со всеми предстоящими бронями, остатком мест на сегодня одним взглядом и пометкой неявившихся гостей. Аккуратно обрабатывай странный или неполный ввод, держи данные гостей приватными и на каждом шаге будь дружелюбным и понятным. Оплата не нужна.',
    ],
  },
  {
    title: ['Trip expense splitter', 'Раздел расходов в поездке'],
    blurb: [
      'Group trips · log expenses · who-owes-whom · settle up',
      'Групповые поездки · учёт трат · кто кому должен · расчёт долгов',
    ],
    prompt: [
      'I want a Telegram bot that splits expenses for a trip with friends, so nobody has to do the math or chase people for money. It should work inside our group chat: I create a trip, set its currency, and add everyone, then anyone can log an expense — who paid, how much, and what for — split evenly or by custom shares when only some of us were in on it. The bot keeps a running tally of who owes whom, simplified down to the fewest payments, and we can see the balance any time with /balance. When it\'s time to settle, people pay each other back however they like and then mark the debt as paid in the bot, which always asks for a quick confirm before clearing it. Handle the awkward parts: round amounts so balances always net to zero, never lose an expense someone logged, and cope with people joining or leaving partway through. Keep each trip\'s amounts visible only to its members, and give the organizer a clean overview of the whole trip and every expense in it.',
      'Хочу телеграм-бота, который делит расходы в поездке с друзьями, чтобы никому не пришлось считать самому или выпрашивать деньги. Он должен работать прямо в нашем групповом чате: я создаю поездку, задаю валюту и добавляю всех, а дальше любой может записать трату — кто заплатил, сколько и за что — разделив поровну или по индивидуальным долям, когда участвовали не все. Бот ведёт текущий подсчёт, кто кому должен, сводит его к минимальному числу платежей, и баланс можно посмотреть в любой момент командой /balance. Когда приходит время рассчитаться, люди возвращают деньги друг другу как им удобно, а потом отмечают долг как оплаченный в боте, который всегда просит быстрое подтверждение перед списанием. Разбирайся с неудобными моментами: округляй суммы так, чтобы балансы всегда сходились в ноль, никогда не теряй записанную кем-то трату и справляйся с тем, что люди присоединяются или уходят по ходу поездки. Держи суммы каждой поездки видимыми только её участникам, а организатору дай понятный обзор всей поездки и каждой траты в ней.',
    ],
  },
  {
    title: ['Habit & streak tracker', 'Трекер привычек и серий'],
    blurb: [
      'Daily check-ins · streaks · reminders · weekly recap',
      'Ежедневные отметки · серии · напоминания · недельный итог',
    ],
    prompt: [
      'I want a Telegram bot that helps me build habits and keep streaks going. Each person sets up their own habits — "drink water", "read 20 minutes", "no smoking" — and chooses how often each should happen: every day, certain weekdays, or a number of times a week. The bot sends a gentle reminder at a time I pick and lets me check in with a single tap, then tracks my current streak, my longest streak, and my completion rate, and celebrates milestones without being cheesy. I can mark a day done, skipped, or missed, edit or pause a habit any time, and see a clean weekly recap of how I did. Handle time zones so reminders land at the right local time, never double-count a check-in, and keep each person\'s habits and history completely private. Give me all my habits at a glance, and make missing a day feel encouraging instead of punishing.',
      'Хочу телеграм-бота, который помогает мне вырабатывать привычки и не прерывать серии. Каждый заводит свои привычки — «пить воду», «читать 20 минут», «не курить» — и выбирает, как часто их выполнять: каждый день, по определённым дням недели или сколько-то раз в неделю. Бот присылает мягкое напоминание во время, которое я выберу, и позволяет отметиться одним нажатием, а затем считает мою текущую серию, самую длинную серию и процент выполнения и отмечает важные вехи без приторности. Я могу пометить день как выполненный, пропущенный или проваленный, изменить или поставить привычку на паузу в любой момент и посмотреть аккуратный недельный итог. Учитывай часовые пояса, чтобы напоминания приходили в правильное местное время, никогда не засчитывай отметку дважды и держи привычки и историю каждого пользователя полностью приватными. Показывай мне все мои привычки одним взглядом, и пусть пропущенный день ощущается ободряюще, а не наказывающе.',
    ],
  },
  {
    title: ['Vocabulary flashcards', 'Карточки для запоминания слов'],
    blurb: [
      'Spaced repetition · daily reviews · custom decks · progress',
      'Интервальные повторения · ежедневные повторы · свои колоды · прогресс',
    ],
    prompt: [
      'I want a Telegram bot that helps me learn a language by drilling vocabulary with spaced repetition. I can add my own word pairs — word, translation, and an optional example sentence — or pick from ready-made starter decks, and the bot schedules reviews so each card comes back right before I\'d forget it: cards I find hard return sooner, easy ones later. Each review is quick — it shows the prompt, I try to recall, then tap to reveal and rate myself "again", "hard", "good", or "easy". Nudge me when reviews are due and let me set how many new cards to learn per day so I don\'t get overwhelmed. I can browse, edit, and delete cards and organize them into decks. Show my streak, how many words I\'ve learned, and what\'s due today. Keep every person\'s decks and progress private, save my place if I stop mid-session, and handle empty decks or a finished session with a friendly message.',
      'Хочу телеграм-бота, который помогает мне учить язык, прогоняя слова с интервальными повторениями. Я могу добавлять свои пары — слово, перевод и необязательный пример в предложении — или брать готовые стартовые колоды, а бот планирует повторения так, чтобы каждая карточка возвращалась прямо перед тем, как я её забуду: трудные карточки возвращаются раньше, лёгкие — позже. Каждое повторение быстрое — бот показывает вопрос, я пытаюсь вспомнить, затем нажимаю, чтобы открыть ответ, и оцениваю себя: «снова», «трудно», «хорошо» или «легко». Напоминай мне, когда пора повторять, и дай задать, сколько новых карточек учить в день, чтобы меня не завалило. Я могу просматривать, редактировать и удалять карточки и раскладывать их по колодам. Показывай мою серию, сколько слов я выучил и что нужно повторить сегодня. Держи колоды и прогресс каждого пользователя приватными, сохраняй моё место, если я прервусь на середине сессии, и обрабатывай пустые колоды или завершённую сессию дружелюбным сообщением.',
    ],
  },
  {
    title: ['Group welcome & guard', 'Приветствие и защита группы'],
    blurb: [
      'Greet newcomers · human check · anti-spam · admin tools',
      'Приветствие новичков · проверка на человека · антиспам · инструменты админа',
    ],
    prompt: [
      'I want a Telegram bot that runs my group chat — welcoming new members and keeping out spam. When someone joins, greet them by name with a short welcome and the rules, and ask them to tap a button to confirm they\'re human before they can post; if they don\'t verify within a few minutes, quietly remove them so bots never get in. Watch for obvious spam — links from brand-new accounts, repeated identical messages, flood posting — and warn, mute, or remove based on thresholds I set. Give admins simple commands to warn, mute, kick, or ban, and keep a short log of actions so we can see who did what. Let me edit the welcome message and rules, choose which actions are automatic, and mark trusted users as exempt. Never act on admins or pinned content, explain every automated action so it doesn\'t feel arbitrary, and give me an overview of joins, verifications, and removals over time.',
      'Хочу телеграм-бота, который ведёт мой групповой чат — встречает новых участников и не пускает спам. Когда кто-то заходит, поприветствуй его по имени коротким сообщением с правилами и попроси нажать кнопку, чтобы подтвердить, что он человек, прежде чем он сможет писать; если он не пройдёт проверку за несколько минут, тихо удали его, чтобы боты никогда не попадали внутрь. Следи за явным спамом — ссылки от совсем новых аккаунтов, повторяющиеся одинаковые сообщения, флуд — и предупреждай, отправляй в мьют или удаляй в зависимости от порогов, которые я задам. Дай админам простые команды, чтобы предупредить, замьютить, кикнуть или забанить, и веди краткий журнал действий, чтобы было видно, кто что сделал. Дай мне менять приветствие и правила, выбирать, какие действия автоматические, и помечать доверенных пользователей как исключения. Никогда не применяй меры к админам и закреплённым сообщениям, объясняй каждое автоматическое действие, чтобы оно не выглядело произвольным, и дай мне обзор входов, проверок и удалений за период.',
    ],
  },
  {
    title: ['Appointment booking', 'Запись на приём'],
    blurb: [
      'Pick a service & slot · confirmations · reminders · reschedule',
      'Выбор услуги и слота · подтверждения · напоминания · перенос',
    ],
    prompt: [
      'I want a Telegram bot that books appointments for my one-person business — like a barber, tutor, or coach. A client taps to start, picks the service they want (each with its own length, and a price to show if I set one), then a day and an open time; the bot only offers slots that fit my working hours and aren\'t already taken, so it can never double-book me. It confirms instantly with the details and a reference code, sends a reminder the day before and an hour before, and lets clients reschedule or cancel from buttons. I configure my services, weekly availability, breaks, and days off, and I can block out time when something comes up. Give me an owner view of today\'s and the week\'s bookings, and ping me the moment a booking comes in or someone cancels. Handle odd input gracefully, keep client contact details private, and stay warm and clear throughout. No online payment needed — we settle in person.',
      'Хочу телеграм-бота, который записывает клиентов на приём в моём деле, где я работаю один — например, барбер, репетитор или коуч. Клиент нажимает «начать», выбирает нужную услугу (у каждой своя длительность и цена, если я её укажу), затем день и свободное время; бот предлагает только слоты, которые вписываются в мои рабочие часы и ещё не заняты, так что двойной записи не будет. Он мгновенно подтверждает запись с деталями и кодом брони, шлёт напоминание за день и за час, и даёт клиентам переносить или отменять запись кнопками. Я настраиваю свои услуги, доступность по неделе, перерывы и выходные и могу заблокировать время, когда что-то случается. Дай мне вид владельца с записями на сегодня и на неделю и пингуй меня в тот же момент, как приходит запись или кто-то отменяет. Аккуратно обрабатывай странный ввод, держи контактные данные клиентов приватными и будь тёплым и понятным на всех шагах. Онлайн-оплата не нужна — рассчитываемся лично.',
    ],
  },
  {
    title: ['Async team standup', 'Асинхронный стендап команды'],
    blurb: [
      'Daily check-ins · channel digest · nudges · blocker history',
      'Ежедневные отметки · дайджест в канал · напоминания · история блокеров',
    ],
    prompt: [
      'I want a Telegram bot that runs an async daily standup for my team so we can skip the meeting. Each workday at a time I set, the bot privately messages everyone three questions — what you did yesterday, what you\'re doing today, and anything blocking you — and collects the answers. Once people respond or a cutoff passes, it posts a clean digest to our team channel grouped by person, clearly listing anyone still pending and anything flagged as a blocker so nothing slips. Nudge people who haven\'t answered, but only once, and let anyone skip a day or mark themselves off. I can set the schedule, the questions, the team, the channel, and which days to run. Respect each person\'s time zone, never post a half-finished digest, and keep answers tidy. Give me a simple history so we can look back at past standups and spot blockers that keep coming up.',
      'Хочу телеграм-бота, который проводит асинхронный ежедневный стендап для моей команды, чтобы обойтись без встречи. Каждый рабочий день во время, которое я задам, бот пишет каждому лично три вопроса — что ты сделал вчера, что делаешь сегодня и что тебя блокирует — и собирает ответы. Когда люди ответили или прошёл дедлайн, бот публикует аккуратный дайджест в наш командный канал, сгруппированный по людям, чётко перечисляя тех, кто ещё не ответил, и всё, что помечено как блокер, чтобы ничего не потерялось. Напоминай тем, кто не ответил, но только один раз, и дай любому пропустить день или отметиться отсутствующим. Я могу задать расписание, вопросы, команду, канал и в какие дни запускать. Учитывай часовой пояс каждого, никогда не публикуй недособранный дайджест и держи ответы опрятными. Дай мне простую историю, чтобы можно было заглянуть в прошлые стендапы и заметить блокеры, которые всплывают снова и снова.',
    ],
  },
  {
    title: ['Event RSVP', 'Сбор откликов на мероприятие'],
    blurb: [
      'Invites · yes/no/maybe · headcount · waitlist · reminders',
      'Приглашения · да/нет/возможно · счётчик гостей · лист ожидания · напоминания',
    ],
    prompt: [
      'I want a Telegram bot that handles RSVPs for events I organize, big or small. I create an event with a title, date and time, place, and an optional guest limit, and the bot gives me a shareable link or posts it in a group where people RSVP with one tap — going, not going, or maybe — and can add a "+1" or a note. It keeps a live headcount, enforces the limit with a waitlist that auto-promotes people if someone drops out, and shows me the full guest list any time. Send reminders before the event to everyone who said yes, and let people change their answer up to a cutoff I set. I can edit the event, message all attendees at once, and close RSVPs when I\'m ready. Handle a full event gracefully, never lose a response, keep the guest list visible only to me unless I share it, and confirm every RSVP so people know it registered.',
      'Хочу телеграм-бота, который собирает отклики на мероприятия, которые я организую, большие и маленькие. Я создаю мероприятие с названием, датой и временем, местом и необязательным лимитом гостей, а бот даёт мне ссылку, которой можно поделиться, или публикует пост в группе, где люди откликаются одним нажатием — иду, не иду или возможно — и могут добавить «+1» или комментарий. Он ведёт живой счётчик гостей, соблюдает лимит с помощью листа ожидания, который автоматически поднимает людей, если кто-то отказывается, и в любой момент показывает мне полный список гостей. Шли напоминания перед мероприятием всем, кто ответил «иду», и дай людям менять ответ до дедлайна, который я задам. Я могу редактировать мероприятие, писать всем участникам сразу и закрыть приём откликов, когда буду готов. Аккуратно обрабатывай ситуацию, когда мест не осталось, никогда не теряй отклик, держи список гостей видимым только мне, пока я сам им не поделюсь, и подтверждай каждый отклик, чтобы люди знали, что он засчитан.',
    ],
  },
  {
    title: ['Personal budget tracker', 'Личный трекер бюджета'],
    blurb: [
      'Log spending · categories · monthly budgets · summaries',
      'Учёт трат · категории · бюджеты на месяц · сводки',
    ],
    prompt: [
      'I want a Telegram bot that helps me track my spending without a spreadsheet. I log an expense in seconds — just the amount and a category like food, transport, or rent, with an optional note — and the bot keeps a running total for the month. I can set a monthly budget overall and per category, and it warns me when I\'m getting close or have gone over, so there are no surprises. Offer my common categories as quick buttons, remember the ones I use most, and let me add, edit, or delete entries and create my own categories. Give me a clear summary any time — spent so far this month, broken down by category, and how each compares to its budget — plus an end-of-month recap. Pick a currency once and stick to it, total everything correctly to the cent, and roll cleanly into a new month. Keep all my data private to me, and make fixing a typo\'d amount or a wrong category effortless.',
      'Хочу телеграм-бота, который помогает мне вести учёт трат без таблиц. Я записываю трату за секунды — просто сумму и категорию вроде еды, транспорта или аренды, с необязательным комментарием — а бот ведёт текущий итог за месяц. Я могу задать месячный бюджет в целом и по каждой категории, и бот предупреждает, когда я приближаюсь к лимиту или превысил его, чтобы не было сюрпризов. Предлагай мои частые категории быстрыми кнопками, запоминай те, что я использую чаще всего, и дай мне добавлять, редактировать и удалять записи и создавать свои категории. Давай мне понятную сводку в любой момент — сколько потрачено с начала месяца, с разбивкой по категориям и в сравнении каждой с её бюджетом — плюс итог в конце месяца. Валюта выбирается один раз и дальше не меняется, всё считается верно до копейки, и переход в новый месяц происходит чисто. Держи все мои данные приватными и сделай так, чтобы исправить опечатку в сумме или неверную категорию было проще простого.',
    ],
  },
  {
    title: ['Group trivia game', 'Викторина для группы'],
    blurb: [
      'Live quizzes · timed questions · scores · leaderboard',
      'Живые викторины · вопросы на время · очки · таблица лидеров',
    ],
    prompt: [
      'I want a Telegram bot that runs fun trivia games in my group chat. Anyone can start a round, pick a category and how many questions, and the bot posts each question with multiple-choice buttons and a countdown; everyone answers at once, faster correct answers score more, and when time\'s up it reveals the right answer and who got it. It keeps scores through the round, shows a live scoreboard between questions, and crowns a winner at the end. Stop people from answering twice, break ties fairly, and keep the pace snappy so the chat stays lively. Ship with a good built-in question set across several categories, and let me add my own questions and answers for custom games. Track an all-time group leaderboard so there are bragging rights over time. If someone abandons a game, time it out cleanly, and make sure two games can\'t run in the same chat at once.',
      'Хочу телеграм-бота, который проводит весёлые викторины в моём групповом чате. Любой может начать раунд, выбрать категорию и число вопросов, а бот публикует каждый вопрос с вариантами-кнопками и обратным отсчётом; все отвечают одновременно, за более быстрый правильный ответ даётся больше очков, а когда время вышло, бот показывает верный ответ и кто его угадал. Он ведёт счёт в течение раунда, показывает живую таблицу очков между вопросами и объявляет победителя в конце. Не давай отвечать дважды, честно разрешай ничьи и держи бодрый темп, чтобы чат оставался живым. Пусть в комплекте будет хороший встроенный набор вопросов по нескольким категориям, и дай мне добавлять свои вопросы и ответы для собственных игр. Веди общую таблицу лидеров группы за всё время, чтобы было чем похвастаться. Если кто-то бросает игру, аккуратно закрывай её по таймауту и следи, чтобы две игры не шли в одном чате одновременно.',
    ],
  },
  {
    title: ['Support & FAQ desk', 'Поддержка и ответы на частые вопросы'],
    blurb: [
      'Instant FAQ answers · human handoff · tickets · hours',
      'Мгновенные ответы из FAQ · передача человеку · тикеты · часы работы',
    ],
    prompt: [
      'I want a Telegram bot that handles first-line customer support for my product. It greets people, offers the most common questions as tappable buttons, and answers from a FAQ I manage — clear, friendly replies with follow-up suggestions so people can self-serve. When the bot can\'t help or the customer asks for a person, it opens a ticket: collects the details, gives the customer a reference number, and notifies me or my team so we can reply, with the conversation kept tied to that ticket. I can manage the FAQ entries, set business hours (and a polite "we\'re offline, we\'ll get back to you" message outside them), and see open tickets and their status. Make sure nothing falls through the cracks — every unanswered question becomes a ticket — keep each customer\'s conversation private, and confirm when a ticket is opened or resolved. Give me an owner view of the most common questions and ticket volume so I can spot what to fix or add to the FAQ.',
      'Хочу телеграм-бота, который берёт на себя первую линию поддержки клиентов моего продукта. Он приветствует людей, предлагает самые частые вопросы кнопками и отвечает из FAQ, которым я управляю — понятными дружелюбными ответами с подсказками для дальнейших шагов, чтобы люди могли разобраться сами. Когда бот не может помочь или клиент просит человека, он заводит тикет: собирает детали, даёт клиенту номер обращения и уведомляет меня или мою команду, чтобы мы ответили, причём переписка остаётся привязанной к этому тикету. Я могу управлять записями FAQ, задавать часы работы (и вежливое сообщение «мы сейчас не в сети, мы вам ответим» вне них) и видеть открытые тикеты и их статусы. Проследи, чтобы ничего не терялось — каждый вопрос без ответа превращается в тикет — держи переписку каждого клиента приватной и подтверждай, когда тикет открыт или решён. Дай мне вид владельца с самыми частыми вопросами и объёмом тикетов, чтобы я видел, что стоит починить или добавить в FAQ.',
    ],
  },
];

function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  // empty field is always the resting height — mount-time scrollHeight can lie
  // (fonts/layout not settled) and must never stretch an empty box to the cap
  if (!el.value.trim()) { el.style.height = '92px'; return; }
  el.style.height = 'auto';
  // clamp: long ideas scroll past the cap instead of growing unbounded
  el.style.height = Math.min(Math.max(92, el.scrollHeight), 260) + 'px';
}

export type StartBtn = { label: string; disabled?: boolean; busy?: boolean; onClick?: () => void };

export function PromptScreen({ T, idea, setIdea, changed, error, startBtn }: {
  T: Theme; idea: string; setIdea: (v: string) => void; changed: boolean;
  error?: string | null;
  startBtn?: StartBtn | null;
}) {
  const t = useT();
  const { lang, setLang } = useLang();
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { autoGrow(taRef.current); }, [idea]);
  // A fixed set of starter ideas shown as wrapped chips (each still carries a
  // full brief in `.prompt`). No shuffle — matches the prototype's chip row.
  const chips = IDEA_EXAMPLES.slice(0, 6);
  const canStart = !!idea.trim() && !!startBtn && !startBtn.disabled;
  return (
    <div style={{ padding: '16px 22px 0', display: 'flex', flexDirection: 'column' }}>
      {/* brand lockup · language toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
        <Wordmark T={T} size={30} />
        <button onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')} aria-label="Language" style={{
          ...btnReset, fontFamily: T.font, fontSize: 13, fontWeight: 700, letterSpacing: 0.3, color: T.hint,
        }}>{lang === 'ru' ? 'RU' : 'EN'}</button>
      </div>

      {changed && (
        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 13px', borderRadius: 14, marginBottom: 16,
          background: T.accentSoft, border: `1px solid ${T.accentBorder}`,
        }}>
          <TGIcon name="refresh" size={17} color={T.accent} stroke={2} />
          <span style={{ fontFamily: T.font, fontSize: 13.5, color: T.text, lineHeight: '18px' }}>
            {t("Edit your idea below — I'll rebuild and re-test from here.", 'Измените описание ниже — я пересоберу и заново протестирую.')}
          </span>
        </div>
      )}

      {/* eyebrow */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
        background: T.sage, borderRadius: 999, padding: '7px 14px', marginBottom: 16,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: T.green }} />
        <span style={{ fontFamily: T.font, fontSize: 13.5, fontWeight: 600, color: '#3f6b4a' }}>
          {t('Build a bot just by chatting', 'Соберите бота просто в переписке')}
        </span>
      </div>

      {/* two-tone hero */}
      <div style={{ fontFamily: T.font, fontSize: 33, fontWeight: 800, color: T.text, letterSpacing: -1, lineHeight: '37px' }}>
        {lang === 'ru'
          ? <>Опишите бота, <span style={{ color: T.accent }}>который нужен</span></>
          : <>Describe the bot <span style={{ color: T.accent }}>you want</span></>}
      </div>
      <div style={{ fontFamily: T.font, fontSize: 15.5, fontWeight: 500, color: T.sub, marginTop: 12, lineHeight: '22px' }}>
        {t('Describe it, tap Create your bot, and it’s live — refine it by chatting. No coding.',
           'Опишите бота, нажмите «Создать бота» — и он в эфире. Дорабатывайте в переписке. Без кода.')}
      </div>

      {/* prompt card with send button */}
      <div style={{
        marginTop: 22, borderRadius: 22, background: T.cardBg, border: `1px solid ${idea ? T.accentBorder : T.sep}`,
        boxShadow: T.shadow, padding: 18, transition: 'border-color .2s',
      }}>
        <textarea
          ref={taRef} value={idea} onChange={e => setIdea(e.target.value)} rows={3}
          placeholder={t('For example: a bot that takes coffee pre-orders — guests pick a drink, pay in store, and it pings them when it is ready…',
                         'Например: бот для предзаказов кофе — гости выбирают напиток, платят в кафе, а бот пишет, когда заказ готов…')}
          style={{
            width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent',
            fontFamily: T.font, fontSize: 16, lineHeight: '23px', color: T.text, padding: 0, minHeight: 92,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button
            onClick={canStart && !startBtn?.busy ? startBtn!.onClick : undefined}
            disabled={!canStart}
            style={{
              ...btnReset, height: 46, padding: '0 16px 0 18px', borderRadius: 14,
              background: canStart ? T.accent : T.nestedBg, color: canStart ? T.accentText : T.hint,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              fontFamily: T.font, fontSize: 15, fontWeight: 700, letterSpacing: -0.2,
              boxShadow: canStart ? T.ctaShadow : 'none', transition: 'background .2s',
              cursor: canStart ? 'pointer' : 'default',
            }}>
            {startBtn?.label || t('Build it', 'Собрать')}
            {startBtn?.busy
              ? <Spinner color={T.accentText} size={18} />
              : <TGIcon name="arrowRight" size={20} color={canStart ? T.accentText : T.hint} stroke={2.4} />}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontFamily: T.font, fontSize: 13, color: T.amber, lineHeight: '18px', marginTop: 10, padding: '0 4px' }}>
          {t("Couldn't start", 'Не удалось запустить')} — {error}. {t('Tap the button to retry.', 'Нажмите кнопку, чтобы повторить.')}
        </div>
      )}

      {/* OR START FROM AN IDEA — wrapped chips */}
      <div style={{ fontFamily: T.font, fontSize: 12, fontWeight: 700, color: T.hint, textTransform: 'uppercase', letterSpacing: 1.4, margin: '24px 2px 12px' }}>
        {t('Or start from an idea', 'Или начните с примера')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
        {chips.map((ex) => (
          <button key={ex.title[0]} onClick={() => setIdea(tr(lang, ...ex.prompt))} style={{
            ...btnReset, padding: '10px 14px', borderRadius: 13, background: T.inputBg,
            border: `1px solid ${T.sep}`, fontFamily: T.font, fontSize: 12.3, fontWeight: 600,
            color: T.text, letterSpacing: -0.1, textAlign: 'left',
          }}>
            {tr(lang, ...ex.title)}
          </button>
        ))}
      </div>
    </div>
  );
}
