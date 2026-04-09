\# Context \& Role

You are an Expert Full-Stack IoT \& Web Developer. I am building a Serverless Weather Station project named `temphum`. 

Your task is to generate the code for this project strictly adhering to the decoupled architecture described below. 



Do NOT suggest adding a traditional backend server (e.g., Express.js, FastAPI). We are using a 100% serverless approach with MongoDB Atlas App Services.



\# Architecture Overview

1\. \*\*IoT Node:\*\* ESP32 with a DHT22/BME280 sensor. Sends data directly to MongoDB Atlas via HTTP POST (Atlas Data API). Operates in Deep Sleep.

2\. \*\*Database:\*\* MongoDB Atlas M0 (Free Tier). 

&#x20;  - `meteo\_db.weather\_raw` (Raw telemetry, has a 7-day TTL index).

&#x20;  - `meteo\_db.weather\_archive` (Daily aggregated data).

3\. \*\*Database Logic:\*\* Atlas Scheduled Trigger running an Atlas Function (JavaScript) once a day to perform downsampling (aggregation) from `weather\_raw` to `weather\_archive`.

4\. \*\*Web UI:\*\* Next.js (App Router) deployed on Vercel. Fetches data directly from MongoDB and displays charts.



\# Directory Structure

The project is located at `c:\\dev\\temphum`.

```text

temphum/

├── firmware/          # ESP32 C++ Code

├── web/               # Next.js App

└── db\_functions/      # JS scripts for Atlas Functions

