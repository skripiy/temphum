// Next.js App Router API Endpoint: /api/weather
import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

// Эта директива нужна, чтобы Next.js не кэшировал статический ответ при сборке,
// так как данные IoT всегда динамические
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db('meteo_db');
    
    // Получаем последнюю запись из базы сырых данных (текущая погода)
    const rawData = await db
      .collection('weather_raw')
      .find({})
      .sort({ _id: -1 }) // Сортируем в обратном порядке (_id хранит время создания)
      .limit(1)          // Берем самый свежий документ
      .toArray();
      
    // Получаем архивные (агрегированные) данные за последние дни
    const archiveData = await db
      .collection('weather_archive')
      .find({})
      .sort({ _id: 1 })  // Хронологический порядок (_id = строка с датой)
      .limit(30)         // Последние 30 записей (дней)
      .toArray();

    // Возвращаем данные клиенту
    return NextResponse.json({
      success: true,
      current: rawData.length ? rawData[0] : null,
      archive: archiveData
    });
  } catch (error: any) {
    console.error('Ошибка в API роуте /api/weather:', error);
    return NextResponse.json({
      success: false,
      error: 'Внутренняя ошибка сервера. Проверьте подключение к базе данных.'
    }, { status: 500 });
  }
}
