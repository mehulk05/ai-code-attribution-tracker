FROM node:18-alpine

# Install Git (required for clone, blame, and log forensics)
RUN apk add --no-cache git

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose the server port
EXPOSE 4000

# Run the backend server
CMD ["node", "src/server.js"]
