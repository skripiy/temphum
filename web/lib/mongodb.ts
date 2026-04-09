// Вспомогательный скрипт для подключения к MongoDB из Next.js
// Позволяет кэшировать соединение в режиме разработки для быстрой перезагрузки (Fast Refresh)
import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI) {
  throw new Error('Укажите переменную окружения MONGODB_URI (например, в файле .env.local)');
}

const uri = process.env.MONGODB_URI;
const options = {};

let client: MongoClient;
let clientPromise: Promise<MongoClient>;

if (process.env.NODE_ENV === 'development') {
  // В режиме разработки кэшируем экземпляр клиента в глобальной области видимости,
  // чтобы избежать создания бесконечного числа подключений при изменении кода.
  // @ts-ignore
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, options);
    // @ts-ignore
    global._mongoClientPromise = client.connect();
  }
  // @ts-ignore
  clientPromise = global._mongoClientPromise;
} else {
  // В режиме production всегда создаем новый экземпляр (Vercel сам оптимизирует подключения)
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

// Экспортируем только Promise подключения к БД
export default clientPromise;
