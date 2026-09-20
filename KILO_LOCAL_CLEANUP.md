# Локальная очистка истории Kilo

Памятка для текущей локальной сборки Kilo на Windows.

## Важная переменная

Dev-сборка без этой переменной использует отдельную channel-БД вроде `kilo-dev8.db`, а не основную историю.

В каждом новом PowerShell перед проверкой или очисткой установить:

```powershell
$env:KILO_DISABLE_CHANNEL_DB = "1"
```

Проверить активный путь к БД:

```powershell
kilo --pure db path
```

Ожидаемый путь:

```text
C:\Users\Alina\.local\share\kilo\kilo.db
```

`KILO_BIN_PATH` больше не нужен: текущий бинарник уже установлен напрямую в:

```text
C:\Users\Alina\.bun\bin\kilo.exe
```

Старая версия сохранена в:

```text
C:\Users\Alina\.bun\bin\kilo.exe.before-kilocode-local
```

## Предпросмотр

Предпросмотр ничего не удаляет. Без `--apply` и `--yes` команда работает только в dry-run:

```powershell
$env:KILO_DISABLE_CHANNEL_DB = "1"
kilo --pure session cleanup --older-than 7 --limit 100
```

Показать до 1000 кандидатов:

```powershell
$env:KILO_DISABLE_CHANNEL_DB = "1"
kilo --pure session cleanup --older-than 7 --limit 1000
```

В выводе:

- `inspected` — сколько сессий просмотрено;
- `candidates` — сколько старых дочерних subagent-сессий найдено;
- `selected` — сколько попадёт в текущий batch;
- `sessions` — первые 25 записей для проверки.

## Удаление

Перед удалением закрыть VS Code/Kilo, чтобы не было активных операций с БД.

Удалить batch до 1000 сессий:

```powershell
$env:KILO_DISABLE_CHANNEL_DB = "1"
kilo --pure session cleanup --older-than 7 --limit 1000 --apply --yes
```

Повторять команду, пока `candidates` не станет равен `0`.

Очистка затрагивает только старые leaf-дочерние subagent-сессии. Root-чаты не выбираются.

## Компактизация

После удаления выполнить `VACUUM`, чтобы уменьшить физический размер SQLite-файла:

```powershell
$env:KILO_DISABLE_CHANNEL_DB = "1"
kilo --pure session cleanup --older-than 7 --limit 1000 --apply --yes --vacuum
```

`VACUUM` требует свободного места и может выполняться долго. Не прерывать процесс.

## Резервная копия

Перед первым удалением можно сделать копию основной БД:

```powershell
Copy-Item `
  "C:\Users\Alina\.local\share\kilo\kilo.db" `
  "C:\Users\Alina\.local\share\kilo\kilo.db.before-cleanup" `
  -Force
```

Также при наличии можно сохранить `kilo.db-wal` и `kilo.db-shm`.

## Установка текущего CLI

Из корня репозитория:

```powershell
bun run --cwd packages/opencode script/build.ts --single --skip-install
```

Текущий Windows-бинарник:

```text
packages\opencode\dist\@kilocode\cli-windows-x64\bin\kilo.exe
```

Глобальный `kilo` уже переключён на этот бинарник. Версию можно проверить:

```powershell
kilo --version
```
