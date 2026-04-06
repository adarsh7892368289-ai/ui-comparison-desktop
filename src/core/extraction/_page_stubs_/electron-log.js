const prefix = '[ui-extract]';

const logger = {
  debug:      (...args) => console.debug(prefix, ...args),
  info:       (...args) => console.info(prefix, ...args),
  warn:       (...args) => console.warn(prefix, ...args),
  error:      (...args) => console.error(prefix, ...args),
  log:        (...args) => console.log(prefix, ...args),
  verbose:    (...args) => console.debug(prefix, ...args),
  initialize: () => {},
};

export default logger;
