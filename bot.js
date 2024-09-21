import TelegramBot from "node-telegram-bot-api";
import puppeteer from "puppeteer";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import startConnection from "./startConnection.js";
import dotenv from 'dotenv'

dotenv.config()

// Инициализация бота
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: true,
});

// Инициализация сервера и базы данных
const app = express();
const port = process.env.SERVER_PORT || 4000;
const client = await startConnection(); // Подключение к базе данных

app.use(cors());
app.use(bodyParser.json());

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Получение всех активных подписчиков
const getSubscribers = async () => {
  const res = await client.query(
    "SELECT chat_id FROM subscribers WHERE is_active = TRUE"
  );
  return res.rows.map((row) => row.chat_id);
};

// Получение подписчика по ID
const getSubscriberById = async (chatId) => {
  const res = await client.query('SELECT * FROM subscribers WHERE chat_id = $1', [chatId]);
  return res.rows[0] || null;
};

// Функция добавления подписчика или активации существующего
const addSubscriber = async (chatId) => {
  const subscriber = await getSubscriberById(chatId);
  
  if (subscriber) {
    if (!subscriber.is_active) {
      await activateSubscriber(chatId);
    }
  } else {
    await client.query(
      "INSERT INTO subscribers (chat_id, is_active) VALUES ($1, TRUE)",
      [chatId]
    );
  }
};

// Активация подписчика
const activateSubscriber = async (chatId) => {
  await client.query('UPDATE subscribers SET is_active = TRUE WHERE chat_id = $1', [chatId]);
};

// Деактивация подписчика
const deactivateSubscriber = async (chatId) => {
  await client.query('UPDATE subscribers SET is_active = FALSE WHERE chat_id = $1', [chatId]);
};

// Функции работы с отправленными машинами
const addSentCar = async (chatId, link) => {
  await client.query(
    "UPDATE subscribers SET sent_cars = array_append(sent_cars, $1) WHERE chat_id = $2",
    [link, chatId]
  );
};

const getSentCars = async (chatId) => {
  const res = await client.query(
    "SELECT sent_cars FROM subscribers WHERE chat_id = $1",
    [chatId]
  );
  return res.rows[0]?.sent_cars || [];
};

// Команды бота: подписка
bot.onText(/\/subscribe/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const subscriber = await getSubscriberById(chatId);

  if (!subscriber) {
    await addSubscriber(chatId);
    bot.sendMessage(chatId, 'Вы подписались на уведомления о новых машинах.');
    console.log('Новый подписчик:', chatId);
  } else if (!subscriber.is_active) {
    await activateSubscriber(chatId);
    bot.sendMessage(chatId, 'Ваша подписка активирована.');
    console.log('Подписка активирована:', chatId);
  } else {
    bot.sendMessage(chatId, 'Вы уже подписаны.');
  }
});

// Команды бота: отписка
bot.onText(/\/unsubscribe/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const subscriber = await getSubscriberById(chatId);

  if (subscriber && subscriber.is_active) {
    await deactivateSubscriber(chatId);
    bot.sendMessage(chatId, 'Вы отписались от уведомлений.');
    console.log('Подписчик отписался:', chatId);
  } else {
    bot.sendMessage(chatId, 'Вы не подписаны.');
  }
});

// Проверка новых машин и рассылка
const checkNewCars = async () => {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto("https://auto.kufar.by/l/cars?cur=USD&oph=1&prc=r%3A400%2C1100");

  await page.waitForSelector('[data-cy="auto-listing-block"]');

  const cars = await page.$$eval(
    '[data-cy="auto-listing-block"] section a[class*="styles_wrapper"]',
    (carElements) => {
      return carElements.map((car) => {
        return {
          title: car.querySelector('[class*="styles_title"]')?.textContent,
          price: car.querySelector('[class*="styles_price"]')?.textContent,
          params: car.querySelector('[class*="styles_params"]')?.textContent,
          region: car.querySelector('[class*="styles_region"]')?.textContent,
          date: car.querySelector('[class*="styles_date"]')?.textContent,
          image: car.querySelector("img")?.src,
          link: car.href.slice(0, 39),
        };
      });
    }
  );

  const subscribers = await getSubscribers();
  for (const subscriber of subscribers) {
    const sentCars = await getSentCars(subscriber);

    for (const car of cars) {
      const { title, price, params, region, date, image, link } = car;

      if (!sentCars.includes(link)) {
        await addSentCar(subscriber, link);

        const message = `Новая машина: ${title}\nЦена: ${price}\nДетали: ${params}\nРегион: ${region}\nДата: ${date}\nСсылка: ${link}\n`;
        bot.sendPhoto(subscriber, image, { caption: message });

        console.log("Сообщение отправлено подписчику:", message);
      }
    }
  }

  await browser.close();
};

// Интервал проверки новых машин (каждые 20 секунд)
setInterval(checkNewCars, 20000);