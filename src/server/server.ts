import http from 'http';
import { middleware } from './middleware.ts';
import { env } from '../config/env.ts';
import { PATH } from '../constants/common.constants.ts';
import { DataSource } from 'typeorm';
import dbConfig from '../database/db.config.ts';
import 'reflect-metadata';
import { logger } from '../utils/logger.ts';
import express from 'express';
import { logIncomingTraffic } from './loggerMiddleware.ts';

// const server = http.createServer(middleware);
const localWebhookUrl = `http://localhost:${env.port}${PATH}`;

export const AppDataSource = new DataSource(dbConfig);

export const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(middleware);
app.use(logIncomingTraffic);

export const startServer = async () => {
  try {
    await AppDataSource.initialize();

    logger.info('Connected to the database....');

    app.listen(env.port, () => {
      logger.info(`Server is listening for events at: ${localWebhookUrl}`);
      logger.info('Press Ctrl + C to quit.');
    });
  } catch (error) {
    logger.error('Error connecting to the database:', error);
  }
};
