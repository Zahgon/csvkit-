FROM node:22-alpine

WORKDIR /opt/csvkit
COPY package.json README.rst ./
COPY bin bin
COPY lib lib
COPY man man

RUN npm install --global .
