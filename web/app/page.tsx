import React from 'react';

// Функция (Server Action/Helper) для получения данных на сервере 
// непосредственно перед рендером компонента (React Server Component)
async function getWeatherData() {
  // Определяем базовый URL для API (Vercel подставляет VERCEL_URL при деплое)
  const isProd = process.env.NODE_ENV === 'production';
  const baseUrl = isProd 
    ? `https://${process.env.VERCEL_URL}` 
    : 'http://localhost:3000';
    
  try {
    const res = await fetch(`${baseUrl}/api/weather`, {
      cache: 'no-store' // Никогда не кэшируем, всегда ходим за свежими данными
    });
    
    if (!res.ok) {
      throw new Error(`Ошибка HTTP: ${res.status}`);
    }
    
    return res.json();
  } catch (error) {
    console.error('Ошибка в getWeatherData:', error);
    return { success: false, current: null, archive: [] };
  }
}

// Главная страница (React Server Component)
export default async function DashboardPage() {
  const data = await getWeatherData();

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 p-8 font-sans">
      <div className="max-w-5xl mx-auto">
        
        <header className="mb-10 text-center">
          <h1 className="text-4xl font-extrabold text-slate-900 tracking-tight">Серверлесс Метеостанция</h1>
          <p className="text-slate-500 mt-3 text-lg">ESP32 + MongoDB Atlas + Next.js (temphum)</p>
        </header>

        {/* Индикатор ошибки, если данные не загрузились */}
        {!data.success && (
          <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-8 rounded shadow-sm">
            <p className="font-bold">Ошибка получения данных</p>
            <p>Не удалось подключиться к базе данных. Проверьте логи сервера.</p>
          </div>
        )}

        {/* ----- Панель Текущих Данных ----- */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 text-slate-700">Сейчас</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 flex flex-col items-center justify-center transition-transform hover:scale-[1.02]">
              <span className="text-slate-400 text-sm font-bold uppercase tracking-widest mb-3">Температура</span>
              {data.current ? (
                <div className="flex items-start">
                  <span className="text-7xl font-black text-orange-500">{data.current.temperature.toFixed(1)}</span>
                  <span className="text-3xl font-bold text-slate-300 mt-2 ml-1">°C</span>
                </div>
              ) : (
                <span className="text-2xl font-bold text-slate-300">N/A</span>
              )}
            </div>
            
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 flex flex-col items-center justify-center transition-transform hover:scale-[1.02]">
              <span className="text-slate-400 text-sm font-bold uppercase tracking-widest mb-3">Влажность</span>
              {data.current ? (
                <div className="flex items-start">
                  <span className="text-7xl font-black text-blue-500">{data.current.humidity.toFixed(1)}</span>
                  <span className="text-3xl font-bold text-slate-300 mt-2 ml-1">%</span>
                </div>
              ) : (
                <span className="text-2xl font-bold text-slate-300">N/A</span>
              )}
            </div>
            
          </div>
        </section>

        {/* ----- Панель Архивированных Данных (История) ----- */}
        <section>
          <h2 className="text-2xl font-bold mb-6 text-slate-700">Дневной Архив</h2>
          
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
            {data.archive && data.archive.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm whitespace-nowrap">
                  <thead>
                    <tr className="border-b-2 border-slate-100 uppercase tracking-wider text-slate-400">
                      <th className="py-4 px-4 font-semibold">Дата</th>
                      <th className="py-4 px-4 font-semibold">Средняя Температура</th>
                      <th className="py-4 px-4 font-semibold text-slate-300 pl-8">Min / Max</th>
                      <th className="py-4 px-4 font-semibold">Влажность (ср.)</th>
                      <th className="py-4 px-4 font-semibold text-center mt-0">Кол-во Замеров</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.archive.map((day: any) => (
                      <tr key={day._id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="py-4 px-4 font-bold text-slate-700">{day._id}</td>
                        <td className="py-4 px-4 text-orange-600 font-medium">{day.avg_temp.toFixed(1)} °C</td>
                        <td className="py-4 px-4 pl-8 text-slate-400">
                          {day.min_temp.toFixed(1)} ° / {day.max_temp.toFixed(1)} °
                        </td>
                        <td className="py-4 px-4 text-blue-600 font-medium">{day.avg_humidity.toFixed(1)} %</td>
                        <td className="py-4 px-4 text-slate-400 text-center">{day.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                
                {/* Заглушка для графика */}
                <div className="mt-10 pt-10 border-t border-slate-100 flex flex-col items-center justify-center p-12 bg-slate-50 rounded-xl border-dashed border-2 border-slate-200">
                  <svg className="w-16 h-16 text-slate-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                  </svg>
                  <p className="text-slate-400 font-medium text-lg">Место для графика (Recharts или Chart.js)</p>
                  <p className="text-slate-300 text-sm mt-1">Визуализация тренда температуры и влажности</p>
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <svg className="w-16 h-16 text-slate-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
                <p className="text-slate-500 text-lg">Пока нет архивных данных за прошлые дни.</p>
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
